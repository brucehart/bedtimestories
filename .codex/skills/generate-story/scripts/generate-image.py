#!/usr/bin/env python3
import argparse
import base64
import json
import mimetypes
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

API_BASE = "https://api.replicate.com/v1"
DEFAULT_MODEL = "google/nano-banana-2"
FALLBACK_MODEL = "black-forest-labs/flux-1.1-pro"
DEFAULT_POLL_SECONDS = 3


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def require_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise SystemExit(
            f"{name} is required (export it in the current environment; dotfiles may not be sourced)."
        )
    return value


def read_poll_seconds() -> int:
    raw = os.environ.get("STORY_IMAGE_POLL_SECONDS", "").strip()
    if not raw:
        return DEFAULT_POLL_SECONDS
    try:
        value = int(raw)
    except ValueError:
        log(f"Invalid STORY_IMAGE_POLL_SECONDS: {raw} (using {DEFAULT_POLL_SECONDS})")
        return DEFAULT_POLL_SECONDS
    if value < 1:
        log(f"STORY_IMAGE_POLL_SECONDS must be >= 1 (using {DEFAULT_POLL_SECONDS})")
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
    headers = {
        "Authorization": f"Token {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url=url, method=method, headers=headers, data=data)
    try:
        with urllib.request.urlopen(req) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Replicate API error {exc.code}: {body[:2000]}") from exc


def wait_for_prediction(token: str, prediction_id: str) -> dict:
    poll_seconds = read_poll_seconds()
    url = f"{API_BASE}/predictions/{prediction_id}"
    while True:
        pred = replicate_request(token, "GET", url)
        status = pred.get("status")
        if status == "succeeded":
            return pred
        if status in {"failed", "canceled"}:
            err = pred.get("error") or "Prediction did not succeed."
            raise RuntimeError(f"Prediction {status}: {err}")
        log(f"Image not ready yet (status={status}). Checking again in {poll_seconds}s...")
        time.sleep(poll_seconds)


def first_output_url(output: object) -> str:
    if isinstance(output, str) and output:
        return output
    if isinstance(output, list):
        for item in output:
            if isinstance(item, str) and item:
                return item
    raise RuntimeError(f"Unexpected prediction output: {output!r}")


def guess_extension(url: str, headers: dict[str, str]) -> str:
    content_type = headers.get("Content-Type", "").split(";")[0].strip().lower()
    if content_type:
        ext = mimetypes.guess_extension(content_type)
        if ext:
            return ext
    parsed = urllib.parse.urlparse(url)
    suffix = pathlib.Path(parsed.path).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp"}:
        return suffix
    return ".jpg"


def download_file(url: str, prefix: str, default_ext: str) -> str:
    req = urllib.request.Request(url=url, method="GET")
    with urllib.request.urlopen(req) as resp:
        data = resp.read()
        headers = {k: v for k, v in resp.headers.items()}
    ext = guess_extension(url, headers) or default_ext
    output_path = f"/tmp/{prefix}-{uuid.uuid4().hex}{ext}"
    with open(output_path, "wb") as f:
        f.write(data)
    return output_path


def run_prediction(token: str, model: str, payload: dict) -> tuple[str, str]:
    create_url = f"{API_BASE}/models/{model}/predictions"
    prediction = replicate_request(token, "POST", create_url, payload)
    prediction_id = prediction.get("id")
    if not prediction_id:
        raise RuntimeError(f"Missing prediction id from create response: {prediction}")
    final = wait_for_prediction(token, prediction_id)
    output_url = first_output_url(final.get("output"))
    local_path = download_file(output_url, "story-image", ".jpg")
    return local_path, output_url


def generate(prompt: str, image_paths: list[str], model: str) -> tuple[str, str, str]:
    token = require_env("REPLICATE_API_TOKEN")

    image_input = [to_data_uri(path) for path in image_paths]

    primary_payload = {
        "input": {
            "prompt": prompt,
            "image_input": image_input,
            "aspect_ratio": "16:9",
            "resolution": "1K",
            "output_format": "jpg",
            "safety_filter_level": "block_only_high",
        }
    }

    try:
        local_path, remote_url = run_prediction(token, model, primary_payload)
        return local_path, remote_url, model
    except Exception as primary_err:
        if model != DEFAULT_MODEL:
            raise
        log(f"Primary image model failed ({model}): {primary_err}")
        log(f"Falling back to {FALLBACK_MODEL}...")
        fallback_payload = {
            "input": {
                "prompt": prompt,
                "aspect_ratio": "3:2",
                "output_format": "png",
            }
        }
        local_path, remote_url = run_prediction(token, FALLBACK_MODEL, fallback_payload)
        return local_path, remote_url, FALLBACK_MODEL


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a story cover image via Replicate.")
    parser.add_argument(
        "--image",
        action="append",
        default=[],
        help="Path to a reference image (repeatable).",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"Replicate model slug for image generation (default: {DEFAULT_MODEL}).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print a single JSON object to stdout instead of the raw path.",
    )
    parser.add_argument("prompt", help="Image prompt for the story cover.")
    args = parser.parse_args()

    path, output_url, used_model = generate(args.prompt, args.image, args.model)

    if args.json:
        print(json.dumps({"path": path, "output_url": output_url, "model": used_model}))
    else:
        print(path)


if __name__ == "__main__":
    main()
