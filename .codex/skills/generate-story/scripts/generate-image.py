#!/usr/bin/env python
import argparse
import json
import mimetypes
import os
import sys
import uuid
from google import genai
from google.genai import types

DEFAULT_SUFFIX = "16:9 landscape, 1K resolution, cartoon style, no text or letters."

def save_binary_file(file_name, data):
    with open(file_name, "wb") as f:
        f.write(data)

def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def load_image_parts(image_paths):
    parts = []
    for path in image_paths:
        if not os.path.exists(path):
            raise SystemExit(f"Reference image not found: {path}")
        mime_type, _ = mimetypes.guess_type(path)
        with open(path, "rb") as f:
            data = f.read()
        parts.append(
            types.Part.from_bytes(
                data=data,
                mime_type=mime_type or "image/jpeg",
            )
        )
    return parts


def generate(prompt: str, image_paths) -> str:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise SystemExit(
            "GEMINI_API_KEY is required (export it in the current environment; dotfiles may not be sourced)."
        )

    client = genai.Client(
        api_key=api_key,
    )

    model = "gemini-3-pro-image-preview"
    full_prompt = f"{prompt}. {DEFAULT_SUFFIX}"
    image_parts = load_image_parts(image_paths) if image_paths else []

    contents = [
        types.Content(
            role="user",
            parts=[
                types.Part.from_text(text=full_prompt),
                *image_parts,
            ],
        ),
    ]
    generate_content_config = types.GenerateContentConfig(
        response_modalities=[
            "IMAGE",
            "TEXT",
        ],
        image_config=types.ImageConfig(
            image_size="1K",
        ),
    )

    run_id = uuid.uuid4().hex
    file_index = 0
    saved_path = None

    for chunk in client.models.generate_content_stream(
        model=model,
        contents=contents,
        config=generate_content_config,
    ):
        if (
            chunk.candidates is None
            or chunk.candidates[0].content is None
            or chunk.candidates[0].content.parts is None
        ):
            continue
        parts = chunk.candidates[0].content.parts
        # The model may stream text and image parts in different orders; scan for the first image payload.
        for part in parts:
            if part.inline_data and part.inline_data.data:
                file_name = f"/tmp/story-image-{run_id}-{file_index}"
                file_index += 1
                inline_data = part.inline_data
                data_buffer = inline_data.data
                file_extension = mimetypes.guess_extension(inline_data.mime_type)
                saved_path = f"{file_name}{file_extension}"
                save_binary_file(saved_path, data_buffer)
                break
        if saved_path:
            break
        if chunk.text:
            # Streaming responses may contain text; keep stdout reserved for the final path/JSON.
            log(chunk.text)

    if not saved_path:
        raise SystemExit("No image data was returned by the model.")

    return saved_path


def main():
    parser = argparse.ArgumentParser(description="Generate a story cover image.")
    parser.add_argument(
        "--image",
        action="append",
        default=[],
        help="Path to a reference image (repeatable).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print a single JSON object to stdout instead of the raw path.",
    )
    parser.add_argument("prompt", help="Image prompt for the story cover.")
    args = parser.parse_args()
    path = generate(args.prompt, args.image)
    if args.json:
        print(json.dumps({"path": path, "model": "gemini-3-pro-image-preview"}))
    else:
        print(path)


if __name__ == "__main__":
    main()
