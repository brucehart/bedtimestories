#!/usr/bin/env python3
import argparse
import base64
import json
import mimetypes
import os
import pathlib
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
DEFAULT_MODEL = "google/nano-banana-2"
FALLBACK_MODEL = "black-forest-labs/flux-1.1-pro"
OPENAI_MODEL = "gpt-image-2"
OPENAI_SIZE = "1280x720"
OPENAI_QUALITY = "low"
OPENAI_OUTPUT_FORMAT = "jpeg"
OPENAI_OUTPUT_COMPRESSION = 80
DEFAULT_POLL_SECONDS = 3


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


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


def run_prediction(token: str, model: str, payload: dict) -> tuple[str, str]:
    create_url = f"{REPLICATE_API_BASE}/models/{model}/predictions"
    prediction = replicate_request(token, "POST", create_url, payload)
    prediction_id = prediction.get("id")
    if not prediction_id:
        raise RuntimeError(f"Missing prediction id from create response: {prediction}")
    final = wait_for_prediction(token, prediction_id)
    output_url = first_output_url(final.get("output"))
    local_path = download_file(
        output_url,
        "story-image",
        ".jpg",
        allowed_suffixes={".jpg", ".jpeg", ".jpe", ".png", ".webp"},
    )
    return local_path, output_url


def generate_with_replicate(prompt: str, image_paths: list[str], model: str) -> tuple[str, str, str]:
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


def decode_openai_image(result: dict, model: str) -> tuple[str, None, str]:
    data = result.get("data")
    if not isinstance(data, list) or not data:
        raise RuntimeError(f"Unexpected OpenAI image response: {result}")

    image_base64 = data[0].get("b64_json")
    if not image_base64:
        raise RuntimeError(f"Missing b64_json in OpenAI image response: {result}")

    output_path = f"/tmp/story-image-{uuid.uuid4().hex}.jpg"
    with open(output_path, "wb") as f:
        f.write(base64.b64decode(image_base64))
    return output_path, None, model


def generate_with_openai(prompt: str, image_paths: list[str], model: str) -> tuple[str, None, str]:
    token = require_env("OPENAI_API_KEY")
    headers = {"Authorization": f"Bearer {token}"}

    if image_paths:
        fields = [
            ("model", model),
            ("prompt", prompt),
            ("size", OPENAI_SIZE),
            ("quality", OPENAI_QUALITY),
            ("output_format", OPENAI_OUTPUT_FORMAT),
            ("output_compression", str(OPENAI_OUTPUT_COMPRESSION)),
        ]
        files: list[tuple[str, str, bytes, str]] = []
        for image_path in image_paths:
            path = pathlib.Path(image_path)
            if not path.exists():
                raise SystemExit(f"Reference image not found: {image_path}")
            files.append(
                (
                    "image[]",
                    path.name,
                    path.read_bytes(),
                    mime_type_for_path(str(path)),
                )
            )

        body, content_type = build_multipart_form_data(fields, files)
        result = request_json(
            "POST",
            f"{OPENAI_API_BASE}/images/edits",
            headers={**headers, "Content-Type": content_type},
            data=body,
        )
        return decode_openai_image(result, model)

    result = request_json(
        "POST",
        f"{OPENAI_API_BASE}/images/generations",
        headers=headers,
        payload={
            "model": model,
            "prompt": prompt,
            "size": OPENAI_SIZE,
            "quality": OPENAI_QUALITY,
            "output_format": OPENAI_OUTPUT_FORMAT,
            "output_compression": OPENAI_OUTPUT_COMPRESSION,
        },
    )
    return decode_openai_image(result, model)


def generate(
    prompt: str,
    image_paths: list[str],
    model: str,
    provider: str,
) -> tuple[str, str | None, str]:
    if provider == "openai":
        return generate_with_openai(prompt, image_paths, model)
    return generate_with_replicate(prompt, image_paths, model)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a story cover image.")
    parser.add_argument(
        "--image",
        action="append",
        default=[],
        help="Path to a reference image (repeatable).",
    )
    parser.add_argument(
        "--provider",
        choices=("replicate", "openai"),
        default=os.environ.get("STORY_IMAGE_PROVIDER", DEFAULT_PROVIDER),
        help=f"Image provider to use (default: {DEFAULT_PROVIDER}).",
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
    parser.add_argument("prompt", help="Image prompt for the story cover.")
    args = parser.parse_args()

    default_model = OPENAI_MODEL if args.provider == "openai" else DEFAULT_MODEL
    model = args.model or default_model
    path, output_url, used_model = generate(args.prompt, args.image, model, args.provider)

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
