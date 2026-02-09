#!/usr/bin/env python
import argparse
import json
import mimetypes
import os
import sys
import time
import uuid
from google import genai
from google.genai import types

MODEL = "veo-3.1-fast-generate-preview"
DEFAULT_SUFFIX = "16:9 landscape, 8s, 24 fps, cartoon style, no text or letters."
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


def generate(image_path: str, prompt: str) -> str:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise SystemExit(
            "GEMINI_API_KEY is required (export it in the current environment; dotfiles may not be sourced)."
        )

    client = genai.Client(
        http_options={"api_version": "v1beta"},
        api_key=api_key,
    )

    video_config = types.GenerateVideosConfig(
        aspect_ratio="16:9",
        number_of_videos=1,
        duration_seconds=8,
        resolution="720p",
    )

    mime_type, _ = mimetypes.guess_type(image_path)
    with open(image_path, "rb") as f:
        image_bytes = f.read()
    reference_image = types.Image(
        imageBytes=image_bytes,
        mimeType=mime_type or "image/jpeg",
    )

    full_prompt = f"{prompt}. {DEFAULT_SUFFIX}"

    operation = client.models.generate_videos(
        model=MODEL,
        prompt=full_prompt,
        image=reference_image,
        config=video_config,
    )

    poll_seconds = read_poll_seconds()
    while not operation.done:
        log(f"Video has not been generated yet. Check again in {poll_seconds} seconds...")
        time.sleep(poll_seconds)
        operation = client.operations.get(operation)

    result = operation.result
    if not result:
        raise SystemExit("Error occurred while generating video.")

    generated_videos = result.generated_videos
    if not generated_videos:
        raise SystemExit("No videos were generated.")

    generated_video = generated_videos[0]
    client.files.download(file=generated_video.video)
    output_path = f"/tmp/story-video-{uuid.uuid4().hex}.mp4"
    generated_video.video.save(output_path)
    return output_path


def main():
    parser = argparse.ArgumentParser(description="Generate a story video from a reference image.")
    parser.add_argument("image_path", help="Path to the reference image.")
    parser.add_argument("prompt", help="Video prompt for the story scene.")
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print a single JSON object to stdout instead of the raw path.",
    )
    args = parser.parse_args()
    path = generate(args.image_path, args.prompt)
    if args.json:
        print(json.dumps({"path": path, "model": MODEL}))
    else:
        print(path)


if __name__ == "__main__":
    main()
