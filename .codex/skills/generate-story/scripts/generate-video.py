#!/usr/bin/env python3
import argparse
import base64
import json
import mimetypes
import os
import pathlib
import shutil
import subprocess
import sys
import time
import uuid

from story_media_common import (
    build_multipart_form_data,
    download_file,
    mime_type_for_path,
    request_json,
    require_env,
)

REPLICATE_API_BASE = "https://api.replicate.com/v1"
OPENAI_API_BASE = "https://api.openai.com/v1"
DEFAULT_PROVIDER = "replicate"
DEFAULT_MODEL = "pixverse/pixverse-v5"
OPENAI_MODEL = "sora-2"
OPENAI_SIZE = "1280x720"
# Current Sora video generations accept 4, 8, or 12 seconds. Keep the default
# as close as possible to the prior 5-second target.
OPENAI_SECONDS = 4
DEFAULT_POLL_SECONDS = 10


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def read_poll_seconds() -> int:
    raw = os.environ.get("STORY_VIDEO_POLL_SECONDS", "").strip()
    if not raw:
        return DEFAULT_POLL_SECONDS
    try:
        value = int(raw)
    except ValueError:
        log(f"Invalid STORY_VIDEO_POLL_SECONDS: {raw} (using {DEFAULT_POLL_SECONDS})")
        return DEFAULT_POLL_SECONDS
    if value < 1:
        log(f"STORY_VIDEO_POLL_SECONDS must be >= 1 (using {DEFAULT_POLL_SECONDS})")
        return DEFAULT_POLL_SECONDS
    return value


def to_data_uri(path: str) -> str:
    p = pathlib.Path(path)
    if not p.exists():
        raise SystemExit(f"Reference image not found: {path}")
    mime = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    encoded = base64.b64encode(p.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def replicate_request(token: str, method: str, url: str, payload: dict | None = None) -> dict:
    return request_json(
        method,
        url,
        headers={
            "Authorization": f"Token {token}",
            "Content-Type": "application/json",
        },
        payload=payload,
    )


def wait_for_prediction(token: str, prediction_id: str) -> dict:
    poll_seconds = read_poll_seconds()
    url = f"{REPLICATE_API_BASE}/predictions/{prediction_id}"
    while True:
        pred = replicate_request(token, "GET", url)
        status = pred.get("status")
        if status == "succeeded":
            return pred
        if status in {"failed", "canceled"}:
            err = pred.get("error") or "Prediction did not succeed."
            raise RuntimeError(f"Prediction {status}: {err}")
        log(f"Video not ready yet (status={status}). Checking again in {poll_seconds}s...")
        time.sleep(poll_seconds)


def first_output_url(output: object) -> str:
    if isinstance(output, str) and output:
        return output
    if isinstance(output, list):
        for item in output:
            if isinstance(item, str) and item:
                return item
    raise RuntimeError(f"Unexpected prediction output: {output!r}")


def generate_with_replicate(image_path: str, prompt: str, model: str) -> tuple[str, str, str]:
    token = require_env("REPLICATE_API_TOKEN")
    image_data_uri = to_data_uri(image_path)

    payload = {
        "input": {
            "prompt": prompt,
            "image": image_data_uri,
            "aspect_ratio": "16:9",
            "duration": 5,
            "quality": "540p",
            "effect": "None",
        }
    }

    create_url = f"{REPLICATE_API_BASE}/models/{model}/predictions"
    prediction = replicate_request(token, "POST", create_url, payload)
    prediction_id = prediction.get("id")
    if not prediction_id:
        raise RuntimeError(f"Missing prediction id from create response: {prediction}")

    final = wait_for_prediction(token, prediction_id)
    output_url = first_output_url(final.get("output"))
    local_path = download_file(
        output_url,
        "story-video",
        ".mp4",
        allowed_suffixes={".mp4", ".mov", ".webm"},
    )
    return local_path, output_url, model


def prepare_openai_reference_image(image_path: str) -> str:
    input_path = pathlib.Path(image_path)
    if not input_path.exists():
        raise SystemExit(f"Reference image not found: {image_path}")
    if shutil.which("ffmpeg") is None:
        raise SystemExit("ffmpeg is required for OpenAI video generation.")

    output_path = f"/tmp/story-video-input-{uuid.uuid4().hex}.jpg"
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(input_path),
                "-vf",
                "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720",
                "-frames:v",
                "1",
                "-q:v",
                "2",
                output_path,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"Failed to prepare OpenAI video reference image: {exc}") from exc
    return output_path


def openai_error_message(video: dict) -> str:
    error = video.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or error.get("code") or "Video generation failed.")
    if error:
        return str(error)
    return "Video generation failed."


def openai_multipart_request(token: str, prompt: str, model: str, prepared_path: str) -> dict:
    mime = mime_type_for_path(prepared_path)
    result = subprocess.run(
        [
            "curl",
            "-sS",
            "-X",
            "POST",
            f"{OPENAI_API_BASE}/videos",
            "-H",
            f"Authorization: Bearer {token}",
            "-F",
            f"prompt={prompt}",
            "-F",
            f"model={model}",
            "-F",
            f"size={OPENAI_SIZE}",
            "-F",
            f"seconds={OPENAI_SECONDS}",
            "-F",
            f"input_reference=@{prepared_path};type={mime}",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stdout or result.stderr).strip()
        raise RuntimeError(f"OpenAI video create failed: {detail[:2000]}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        detail = (result.stdout or result.stderr).strip()
        raise RuntimeError(f"Unexpected OpenAI video response: {detail[:2000]}") from exc


def wait_for_openai_video(token: str, video_id: str) -> dict:
    poll_seconds = read_poll_seconds()
    headers = {"Authorization": f"Bearer {token}"}
    url = f"{OPENAI_API_BASE}/videos/{video_id}"

    while True:
        try:
            video = request_json("GET", url, headers=headers)
        except RuntimeError as exc:
            message = str(exc)
            if any(code in message for code in ("API error 500", "API error 502", "API error 503", "API error 504")):
                log(
                    f"OpenAI video status check hit a transient server error. Retrying in {poll_seconds}s..."
                )
                time.sleep(poll_seconds)
                continue
            raise
        status = video.get("status")
        if status == "completed":
            return video
        if status in {"failed", "canceled"}:
            raise RuntimeError(f"Video {status}: {openai_error_message(video)}")
        log(f"Video not ready yet (status={status}). Checking again in {poll_seconds}s...")
        time.sleep(poll_seconds)


def generate_with_openai(image_path: str, prompt: str, model: str) -> tuple[str, str, str]:
    token = require_env("OPENAI_API_KEY")
    prepared_path = prepare_openai_reference_image(image_path)
    headers = {"Authorization": f"Bearer {token}"}

    try:
        video = openai_multipart_request(token, prompt, model, prepared_path)
        video_id = video.get("id")
        if not video_id:
            raise RuntimeError(f"Missing video id from OpenAI response: {video}")

        wait_for_openai_video(token, video_id)
        content_url = f"{OPENAI_API_BASE}/videos/{video_id}/content"
        local_path = download_file(
            content_url,
            "story-video",
            ".mp4",
            headers=headers,
            allowed_suffixes={".mp4", ".mov", ".webm"},
        )
        return local_path, content_url, model
    finally:
        try:
            os.remove(prepared_path)
        except OSError:
            pass


def generate(
    image_path: str,
    prompt: str,
    model: str,
    provider: str,
) -> tuple[str, str, str]:
    if provider == "openai":
        return generate_with_openai(image_path, prompt, model)
    return generate_with_replicate(image_path, prompt, model)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a story video.")
    parser.add_argument("image_path", help="Path to the reference image.")
    parser.add_argument("prompt", help="Video prompt for the story scene.")
    parser.add_argument(
        "--provider",
        choices=("replicate", "openai"),
        default=os.environ.get("STORY_VIDEO_PROVIDER", DEFAULT_PROVIDER),
        help=f"Video provider to use (default: {DEFAULT_PROVIDER}).",
    )
    parser.add_argument(
        "--model",
        help="Override the model for the selected provider.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print a single JSON object to stdout instead of the raw path.",
    )
    args = parser.parse_args()

    default_model = OPENAI_MODEL if args.provider == "openai" else DEFAULT_MODEL
    model = args.model or default_model
    path, output_url, used_model = generate(args.image_path, args.prompt, model, args.provider)
    if args.json:
        print(
            json.dumps(
                {
                    "path": path,
                    "output_url": output_url,
                    "model": used_model,
                    "provider": args.provider,
                }
            )
        )
    else:
        print(path)


if __name__ == "__main__":
    main()
