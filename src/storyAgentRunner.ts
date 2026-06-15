export const STORY_AGENT_RUNNER = String.raw`#!/usr/bin/env python3
import json
import hashlib
import os
import pathlib
import pty
import re
import select
import shlex
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


BASE_URL = os.environ["STORY_AGENT_BASE_URL"].rstrip("/")
JOB_ID = os.environ["STORY_AGENT_JOB_ID"]
JOB_TOKEN = os.environ["STORY_AGENT_TOKEN"]
WORKDIR = os.environ.get("STORY_AGENT_WORKDIR", "/home/sprite/bedtimestories/main")
SECRETS_PATH = pathlib.Path.home() / ".config" / "secrets" / "codex.env"
TASK_NAME = os.environ.get("STORY_AGENT_TASK_NAME") or re.sub(
    r"[^a-z0-9-]+",
    "-",
    ("story-agent-" + JOB_ID).lower(),
).strip("-")
TASK_EXPIRE = "5m"
# Cloudflare's Browser Integrity Check rejects the default "Python-urllib/x.y"
# User-Agent with Error 1010 (browser_signature_banned), which silently blocks
# every callback to the Worker. Present a normal browser User-Agent instead.
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")


def token_hash_prefix():
    return hashlib.sha256(JOB_TOKEN.encode("utf-8")).hexdigest()[:12]


def parse_env_value(raw):
    lexer = shlex.shlex(raw, posix=True)
    lexer.whitespace_split = True
    lexer.commenters = "#"
    parts = list(lexer)
    return " ".join(parts)


def load_secret_env():
    if not SECRETS_PATH.exists():
        return
    for raw_line in SECRETS_PATH.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        name, sep, raw_value = line.partition("=")
        name = name.strip()
        if sep and name and not os.environ.get(name):
            os.environ[name] = parse_env_value(raw_value.strip())
    if os.environ.get("OPENAI_BEDTIME_STORY_KEY") and not os.environ.get("OPENAI_API_KEY"):
        os.environ["OPENAI_API_KEY"] = os.environ["OPENAI_BEDTIME_STORY_KEY"]


def api_request(method, path, payload=None, timeout=30):
    data = None
    headers = {
        "Authorization": "Bearer " + JOB_TOKEN,
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE_URL + path, method=method, headers=headers, data=data)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        body = response.read()
        if not body:
            return {}
        return json.loads(body.decode("utf-8"))


def task_request(method, path, payload=None):
    cmd = [
        "curl",
        "-fsS",
        "--unix-socket",
        "/.sprite/api.sock",
        "-X",
        method,
        "http://sprite" + path,
    ]
    if payload is not None:
        cmd.extend(["-H", "Content-Type: application/json", "-d", json.dumps(payload)])
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)


def refresh_task():
    task_request("PUT", "/v1/tasks/" + urllib.parse.quote(TASK_NAME), {"expire": TASK_EXPIRE})


def release_task():
    subprocess.run(
        [
            "curl",
            "-fsS",
            "--unix-socket",
            "/.sprite/api.sock",
            "-X",
            "DELETE",
            "http://sprite/v1/tasks/" + urllib.parse.quote(TASK_NAME),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )


def heartbeat_task(stop_event):
    while not stop_event.wait(60):
        try:
            refresh_task()
        except Exception as exc:
            post_event("warning", "Could not refresh Sprite task hold: " + str(exc))


def post_event(event_type, message, metadata=None):
    try:
        api_request(
            "POST",
            "/api/agent/jobs/" + urllib.parse.quote(JOB_ID) + "/events",
            {"type": event_type, "message": message, "metadata": metadata or {}},
            timeout=10,
        )
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        print(
            "failed to post event: HTTP Error "
            + str(exc.code)
            + ": "
            + detail[:500],
            file=sys.stderr,
            flush=True,
        )
    except Exception as exc:
        print("failed to post event: " + str(exc), file=sys.stderr, flush=True)


def patch_job(status, **fields):
    payload = {"status": status}
    payload.update(fields)
    api_request("PATCH", "/api/agent/jobs/" + urllib.parse.quote(JOB_ID), payload, timeout=15)


def bootstrap():
    return api_request("GET", "/api/agent/jobs/" + urllib.parse.quote(JOB_ID) + "/bootstrap")


def download_refs(refs):
    paths = []
    output_dir = pathlib.Path("/tmp") / ("story-agent-" + JOB_ID)
    output_dir.mkdir(parents=True, exist_ok=True)
    for ref in refs:
        filename = ref.get("filename") or ("reference-" + str(ref.get("id", len(paths) + 1)) + ".jpg")
        safe_name = pathlib.Path(filename).name or ("reference-" + str(len(paths) + 1) + ".jpg")
        output_path = output_dir / (str(ref.get("id", len(paths) + 1)) + "-" + safe_name)
        req = urllib.request.Request(
            BASE_URL + ref["url"],
            method="GET",
            headers={"Authorization": "Bearer " + JOB_TOKEN, "User-Agent": USER_AGENT},
        )
        with urllib.request.urlopen(req, timeout=60) as response:
            output_path.write_bytes(response.read())
        paths.append(str(output_path))
    return paths


def build_codex_prompt(job, ref_paths):
    date_line = "No explicit target date was provided."
    if job.get("target_date"):
        date_line = "Use this target story date: " + job["target_date"] + "."
    refs = "\n".join("- " + path for path in ref_paths) if ref_paths else "- none"
    reference_instruction = (
        "No reference images were provided."
        if not ref_paths
        else (
            "Reference images are available at the /tmp paths above. "
            "Inspect those files directly and use visible details as inspiration for the story. "
            "When running the generate-story workflow, include every listed path as a separate --ref-image argument "
            "so the media generation provider receives the same references."
        )
    )
    return (
        "Use the generate-story skill to create and publish a bedtime story for James.\n\n"
        "Story idea:\n"
        + job["prompt"]
        + "\n\n"
        + date_line
        + "\n\nReference image paths:\n"
        + refs
        + "\n\n"
        + reference_instruction
        + "\n\nRun the full workflow, including media generation and publishing through the existing story API. "
        "Stream useful progress as you work. When complete, print exactly one final line beginning with "
        "STORY_AGENT_RESULT_JSON= followed by compact JSON containing the actual story_id, title, image_key, "
        "and video_key returned by the publishing workflow. Do not print placeholder values or example JSON.\n"
    )


def strip_terminal(text):
    return ANSI_RE.sub("", text).replace("\r", "")


def poll_messages(proc, input_fd):
    last_id = 0
    while proc.poll() is None:
        try:
            path = "/api/agent/jobs/" + urllib.parse.quote(JOB_ID) + "/messages?after=" + str(last_id)
            data = api_request("GET", path, timeout=10)
            for msg in data.get("messages", []):
                last_id = max(last_id, int(msg["id"]))
                content = msg.get("content", "").strip()
                if content:
                    post_event("feedback", "Forwarding feedback to Codex.")
                    os.write(
                        input_fd,
                        ("\nUser feedback from the manage page:\n" + content + "\n").encode("utf-8"),
                    )
        except Exception as exc:
            post_event("warning", "Could not poll feedback: " + str(exc))
        time.sleep(5)


def parse_result(output):
    output = strip_terminal(output)
    marker = "STORY_AGENT_RESULT_JSON="
    for line in reversed(output.splitlines()):
        if marker in line:
            raw = line.split(marker, 1)[1].strip()
            try:
                parsed = json.loads(raw)
                if is_real_result(parsed):
                    return parsed
            except Exception:
                continue
    for match in reversed(re.findall(r"\{[^{}]*\"story_id\"[^{}]*\}", output)):
        try:
            parsed = json.loads(match)
            if is_real_result(parsed):
                return parsed
        except Exception:
            continue
    return None


def is_real_result(value):
    if not isinstance(value, dict):
        return False
    story_id = value.get("story_id")
    if not isinstance(story_id, int) or story_id <= 0:
        return False
    if value.get("title") == "Title":
        return False
    if value.get("image_key") == "image-key":
        return False
    if value.get("video_key") == "video-key":
        return False
    return True


def main():
    load_secret_env()
    print("story agent runner started; callback token hash prefix " + token_hash_prefix(), flush=True)
    refresh_task()
    task_stop = threading.Event()
    task_thread = threading.Thread(target=heartbeat_task, args=(task_stop,), daemon=True)
    task_thread.start()
    post_event("status", "Sprite task hold acquired.")
    try:
        job = bootstrap()
        patch_job("running")
        post_event("status", "Story agent started in Sprite.")
        ref_paths = download_refs(job.get("refs", []))
        if ref_paths:
            post_event("status", "Downloaded " + str(len(ref_paths)) + " reference image(s).")

        prompt = build_codex_prompt(job, ref_paths)
        env = os.environ.copy()
        env["STORY_API_BASE_URL"] = env.get("STORY_API_BASE_URL") or BASE_URL
        result_path = pathlib.Path("/tmp") / ("story-agent-" + JOB_ID + "-codex-result.txt")
        try:
            result_path.unlink()
        except FileNotFoundError:
            pass
        cmd = [
            "codex",
            "exec",
            "--dangerously-bypass-approvals-and-sandbox",
            "--cd",
            WORKDIR,
            "--color",
            "never",
            "--output-last-message",
            str(result_path),
        ]
        cmd.append(prompt)
        post_event("status", "Launching Codex story workflow.")
        master_fd, slave_fd = pty.openpty()
        proc = subprocess.Popen(
            cmd,
            cwd=WORKDIR,
            env=env,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            close_fds=True,
        )
        os.close(slave_fd)
        post_event("status", "Codex exec process started with pid " + str(proc.pid) + ".")
        thread = threading.Thread(target=poll_messages, args=(proc, master_fd), daemon=True)
        thread.start()

        output_parts = []
        line_buffer = ""
        result = None
        last_output_at = time.time()
        last_idle_event_at = last_output_at
        while True:
            timeout = 0 if proc.poll() is not None else 1
            ready, _, _ = select.select([master_fd], [], [], timeout)
            if not ready:
                if proc.poll() is not None:
                    break
                now = time.time()
                if now - last_output_at > 120 and now - last_idle_event_at > 120:
                    post_event("status", "Codex exec is still running; waiting for output.")
                    last_idle_event_at = now
                continue
            try:
                chunk = os.read(master_fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            text = chunk.decode("utf-8", errors="replace")
            last_output_at = time.time()
            output_parts.append(text)
            line_buffer += text
            while "\n" in line_buffer:
                line, line_buffer = line_buffer.split("\n", 1)
                clean = strip_terminal(line).rstrip()
                if clean:
                    post_event("log", clean)

        if line_buffer:
            clean = strip_terminal(line_buffer).rstrip()
            if clean:
                post_event("log", clean)

        exit_code = proc.wait()
        os.close(master_fd)

        if result_path.exists():
            try:
                final_message = result_path.read_text(encoding="utf-8")
                if final_message:
                    output_parts.append("\n" + final_message)
                    result = parse_result(final_message)
            except Exception as exc:
                post_event("warning", "Could not read Codex final message: " + str(exc))

        if exit_code != 0:
            patch_job("failed", error="Codex exited with status " + str(exit_code))
            post_event("error", "Codex exited with status " + str(exit_code))
            return exit_code

        if not result:
            result = parse_result("".join(output_parts))

        if result and result.get("story_id"):
            patch_job(
                "complete",
                story_id=int(result["story_id"]),
                title=str(result.get("title") or ""),
            )
            post_event("complete", "Story created.", result)
            return 0

        if not result or not result.get("story_id"):
            patch_job("failed", error="Codex completed without a story_id result marker.")
            post_event("error", "Codex completed without a story_id result marker.")
            return 2
    finally:
        task_stop.set()
        release_task()
        post_event("status", "Sprite task hold released.")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        print("HTTP error " + str(exc.code) + ": " + detail[:500], file=sys.stderr, flush=True)
        post_event("error", "HTTP error " + str(exc.code) + ": " + detail[:500])
        try:
            patch_job("failed", error="HTTP error " + str(exc.code))
        except Exception:
            pass
        raise
    except Exception as exc:
        post_event("error", str(exc))
        try:
            patch_job("failed", error=str(exc))
        except Exception:
            pass
        raise
`;
