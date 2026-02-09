#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid


DEFAULT_BASE_URL = "https://bedtimestories.bruce-hart.workers.dev"


def eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise SystemExit(
            f"{name} is required (export it in the current environment; dotfiles may not be sourced)."
        )
    return value


def which_or_die(name: str) -> None:
    if shutil.which(name) is None:
        raise SystemExit(f"Required tool not found on PATH: {name}")


def run_json(cmd: list[str], env: dict | None = None) -> dict:
    proc = subprocess.run(
        cmd, stdout=subprocess.PIPE, stderr=sys.stderr, text=True, env=env
    )
    if proc.returncode != 0:
        raise SystemExit(proc.returncode)
    try:
        return json.loads(proc.stdout)
    except Exception as exc:
        raise SystemExit(f"Expected JSON on stdout, got parse error: {exc}")


def curl_json(args: list[str]) -> dict:
    # args: curl arguments excluding -sS; must include URL and any headers/body flags.
    out_path = tempfile.mktemp(prefix="story-curl-", suffix=".json", dir="/tmp")
    code = subprocess.run(
        ["curl", "-sS", "-o", out_path, "-w", "%{http_code}", *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if code.returncode != 0:
        eprint(code.stderr.strip())
        raise SystemExit(code.returncode)
    status = code.stdout.strip()
    try:
        with open(out_path, "r", encoding="utf-8") as f:
            body = f.read()
    finally:
        try:
            os.remove(out_path)
        except OSError:
            pass
    if status not in ("200", "201"):
        eprint(f"HTTP {status}")
        eprint(body[:1024])
        raise SystemExit(10)
    try:
        return json.loads(body)
    except Exception as exc:
        eprint(body[:1024])
        raise SystemExit(f"Non-JSON response: {exc}")


def read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()

def story_fingerprint(title: str, content: str) -> str:
    # Stable, short identifier used only for debugging/prompt grounding.
    h = hashlib.sha256()
    h.update(title.strip().encode("utf-8"))
    h.update(b"\n---\n")
    h.update(content.strip().encode("utf-8"))
    return h.hexdigest()[:12]


def compact_story_excerpt(content: str, max_chars: int = 700) -> str:
    text = " ".join(content.strip().split())
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "…"


def default_image_prompt(title: str, content: str) -> str:
    excerpt = compact_story_excerpt(content)
    fp = story_fingerprint(title, content)
    return (
        "Cozy bedtime-story cartoon cover illustration (landscape). "
        "Depict ONE key moment from this story, with a warm, gentle mood. "
        "Use only the characters that belong in that moment (no extra people/animals). "
        "No text, letters, signage, logos, or watermarks. "
        f"Story title: {title}. "
        f"Story excerpt: {excerpt} "
        f"(story id tag: {fp})."
    )


def default_video_prompt(title: str, content: str) -> str:
    excerpt = compact_story_excerpt(content)
    fp = story_fingerprint(title, content)
    return (
        "Cartoon 8-second scene (landscape) showing ONE gentle moment from this story. "
        "Slow, steady camera movement, warm lighting, family-friendly. "
        "Match the cover image style and characters; do not add characters not present in the moment. "
        "No text, letters, signage, logos, or watermarks. "
        f"Story title: {title}. "
        f"Story excerpt: {excerpt} "
        f"(story id tag: {fp})."
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="End-to-end story runner: date -> image -> video -> upload -> create story."
    )
    parser.add_argument("--title", required=True, help="Story title.")
    parser.add_argument(
        "--content-file",
        required=True,
        help="Path to the story content file (plain text / markdown-compatible).",
    )
    parser.add_argument("--date", help="Story date (YYYY-MM-DD). If omitted, finds next open date.")
    parser.add_argument(
        "--story-id",
        type=int,
        help="If set, updates an existing story's media (image_url/video_url) instead of creating a new story.",
    )
    parser.add_argument("--base-url", help="Story API base URL.")
    parser.add_argument("--poll-seconds", type=int, default=10, help="Polling interval for video generation.")
    parser.add_argument(
        "--ref-image",
        action="append",
        default=[],
        help="Reference image path to guide the cover image (repeatable).",
    )
    parser.add_argument(
        "--image-prompt",
        help="Override the default cover image prompt.",
    )
    parser.add_argument(
        "--video-prompt",
        help="Override the default video scene prompt.",
    )
    parser.add_argument("--keep-tmp", action="store_true", help="Keep intermediate files under /tmp.")
    parser.add_argument("--json", action="store_true", help="Print final output as JSON.")
    args = parser.parse_args()

    require_env("GEMINI_API_KEY")
    story_token = require_env("STORY_API_TOKEN")

    which_or_die("curl")
    which_or_die("ffmpeg")

    base_url = (args.base_url or os.getenv("STORY_API_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    image_script = os.path.join(scripts_dir, "generate-image.py")
    video_script = os.path.join(scripts_dir, "generate-video.py")
    next_date_script = os.path.join(scripts_dir, "next-open-date.py")

    content = read_text(args.content_file)

    # Safe defaults are derived from the provided title/content so we don't accidentally reuse an old story theme.
    image_prompt = args.image_prompt or default_image_prompt(args.title, content)
    video_prompt = args.video_prompt or default_video_prompt(args.title, content)

    date = args.date
    if not date and not args.story_id:
        proc = subprocess.run(
            [sys.executable, next_date_script],
            stdout=subprocess.PIPE,
            stderr=sys.stderr,
            text=True,
            env={**os.environ, "STORY_API_BASE_URL": base_url},
        )
        if proc.returncode != 0:
            return proc.returncode
        date = proc.stdout.strip()

    image_cmd = [sys.executable, image_script, "--json"]
    for ref in args.ref_image:
        image_cmd.extend(["--image", ref])
    image_cmd.append(image_prompt)
    image_res = run_json(image_cmd)
    image_path = image_res.get("path")
    if not image_path or not os.path.exists(image_path):
        raise SystemExit(f"Image script did not return a valid path: {image_res}")

    video_env = {**os.environ, "STORY_VIDEO_POLL_SECONDS": str(args.poll_seconds)}
    video_res = run_json(
        [sys.executable, video_script, "--json", image_path, video_prompt],
        env=video_env,
    )
    video_path = video_res.get("path")
    if not video_path or not os.path.exists(video_path):
        raise SystemExit(f"Video script did not return a valid path: {video_res}")

    encoded_path = f"/tmp/story-video-encoded-{uuid.uuid4().hex}.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            video_path,
            "-c:v",
            "libx264",
            "-profile:v",
            "high",
            "-level",
            "4.0",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            encoded_path,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
    )

    img_upload = curl_json(
        [
            f"{base_url}/api/media",
            "-H",
            f"X-Story-Token: {story_token}",
            "-F",
            f"file=@{image_path}",
        ]
    )
    vid_upload = curl_json(
        [
            f"{base_url}/api/media",
            "-H",
            f"X-Story-Token: {story_token}",
            "-F",
            f"file=@{encoded_path}",
        ]
    )

    image_key = img_upload.get("key")
    video_key = vid_upload.get("key")
    if not image_key or not video_key:
        raise SystemExit("Upload did not return media keys.")

    payload: dict[str, object] = {}
    if args.story_id:
        # Update media only by default. This prevents accidental content/date edits.
        payload["image_url"] = image_key
        payload["video_url"] = video_key
    else:
        payload = {
            "title": args.title,
            "content": content,
            "date": date,
            "image_url": image_key,
            "video_url": video_key,
        }
    payload_path = tempfile.mktemp(prefix="story-payload-", suffix=".json", dir="/tmp")
    with open(payload_path, "w", encoding="utf-8") as f:
        json.dump(payload, f)

    if args.story_id:
        story_update = curl_json(
            [
                f"{base_url}/api/stories/{args.story_id}",
                "-X",
                "PUT",
                "-H",
                f"X-Story-Token: {story_token}",
                "-H",
                "Content-Type: application/json",
                "--data-binary",
                f"@{payload_path}",
            ]
        )
        story_id = story_update.get("id") or args.story_id
    else:
        story_create = curl_json(
            [
                f"{base_url}/api/stories",
                "-H",
                f"X-Story-Token: {story_token}",
                "-H",
                "Content-Type: application/json",
                "--data-binary",
                f"@{payload_path}",
            ]
        )
        story_id = story_create.get("id")
        if not story_id:
            raise SystemExit(f"Story create did not return id: {story_create}")

    if not args.keep_tmp:
        for p in (payload_path, encoded_path):
            try:
                os.remove(p)
            except OSError:
                pass

    result = {
        "title": args.title,
        "content": content,
        "date": date,
        "image_key": image_key,
        "video_key": video_key,
        "story_id": story_id,
    }
    if args.json:
        print(json.dumps(result))
    else:
        print(f"Title: {args.title}")
        print(f"Date: {date}")
        print(f"Image key: {image_key}")
        print(f"Video key: {video_key}")
        print(f"Story id: {story_id}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
