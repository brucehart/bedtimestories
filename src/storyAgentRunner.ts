export const STORY_AGENT_RUNNER = String.raw`#!/usr/bin/env python3
import json
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
TASK_NAME = "story-agent-" + JOB_ID
TASK_EXPIRE = "5m"
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")


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
            headers={"Authorization": "Bearer " + JOB_TOKEN},
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
            "Reference images are attached to this Codex request and also stored at the /tmp paths above. "
            "Inspect them and use visible details as inspiration for the story. "
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
        "Stream useful progress as you work. When complete, print exactly one final line in this format:\n"
        "STORY_AGENT_RESULT_JSON={\"story_id\":123,\"title\":\"Title\",\"image_key\":\"image-key\",\"video_key\":\"video-key\"}\n"
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
            return json.loads(raw)
    for match in reversed(re.findall(r"\{[^{}]*\"story_id\"[^{}]*\}", output)):
        try:
            return json.loads(match)
        except Exception:
            continue
    return None


def main():
    load_secret_env()
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
        cmd = [
            "codex",
            "--no-alt-screen",
            "--dangerously-bypass-approvals-and-sandbox",
            "--cd",
            WORKDIR,
        ]
        for ref_path in ref_paths:
            cmd.extend(["--image", ref_path])
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
        thread = threading.Thread(target=poll_messages, args=(proc, master_fd), daemon=True)
        thread.start()

        output_parts = []
        line_buffer = ""
        result = None
        while True:
            timeout = 0 if proc.poll() is not None else 1
            ready, _, _ = select.select([master_fd], [], [], timeout)
            if not ready:
                if proc.poll() is not None:
                    break
                continue
            try:
                chunk = os.read(master_fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            text = chunk.decode("utf-8", errors="replace")
            output_parts.append(text)
            line_buffer += text
            while "\n" in line_buffer:
                line, line_buffer = line_buffer.split("\n", 1)
                clean = strip_terminal(line).rstrip()
                if clean:
                    post_event("log", clean)
            result = parse_result("".join(output_parts))
            if result and result.get("story_id"):
                break

        if line_buffer:
            clean = strip_terminal(line_buffer).rstrip()
            if clean:
                post_event("log", clean)

        if result and result.get("story_id"):
            patch_job(
                "complete",
                story_id=int(result["story_id"]),
                title=str(result.get("title") or ""),
            )
            post_event("complete", "Story created.", result)
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
            os.close(master_fd)
            return 0

        exit_code = proc.wait()
        os.close(master_fd)
        output = "".join(output_parts)
        if exit_code != 0:
            patch_job("failed", error="Codex exited with status " + str(exit_code))
            post_event("error", "Codex exited with status " + str(exit_code))
            return exit_code

        result = parse_result(output)
        if not result or not result.get("story_id"):
            patch_job("failed", error="Codex completed without a story_id result marker.")
            post_event("error", "Codex completed without a story_id result marker.")
            return 2

        patch_job(
            "complete",
            story_id=int(result["story_id"]),
            title=str(result.get("title") or ""),
        )
        post_event("complete", "Story created.", result)
        return 0
    finally:
        task_stop.set()
        release_task()
        post_event("status", "Sprite task hold released.")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
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
