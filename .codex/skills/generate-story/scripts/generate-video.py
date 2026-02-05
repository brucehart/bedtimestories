#!/usr/bin/env python
import argparse
import mimetypes
import os
import time
from google import genai
from google.genai import types

MODEL = "veo-3.1-fast-generate-preview"
DEFAULT_SUFFIX = "16:9 landscape, 8s, 24 fps, cartoon style, no text or letters."


def generate(image_path: str, prompt: str) -> str:
    client = genai.Client(
        http_options={"api_version": "v1beta"},
        api_key=os.environ.get("GEMINI_API_KEY"),
    )

    video_config = types.GenerateVideosConfig(
        aspect_ratio="16:9",
        number_of_videos=1,
        duration_seconds=8,
        person_generation="ALLOW_ALL",
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

    while not operation.done:
        print("Video has not been generated yet. Check again in 10 seconds...")
        time.sleep(10)
        operation = client.operations.get(operation)

    result = operation.result
    if not result:
        raise SystemExit("Error occurred while generating video.")

    generated_videos = result.generated_videos
    if not generated_videos:
        raise SystemExit("No videos were generated.")

    generated_video = generated_videos[0]
    client.files.download(file=generated_video.video)
    output_path = "/tmp/story-video-0.mp4"
    generated_video.video.save(output_path)
    print(output_path)
    return output_path


def main():
    parser = argparse.ArgumentParser(description="Generate a story video from a reference image.")
    parser.add_argument("image_path", help="Path to the reference image.")
    parser.add_argument("prompt", help="Video prompt for the story scene.")
    args = parser.parse_args()
    generate(args.image_path, args.prompt)


if __name__ == "__main__":
    main()
