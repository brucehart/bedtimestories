#!/usr/bin/env python
import argparse
import mimetypes
import os
import uuid
from google import genai
from google.genai import types

DEFAULT_SUFFIX = "16:9 landscape, 1K resolution, cartoon style, no text or letters."

def save_binary_file(file_name, data):
    with open(file_name, "wb") as f:
        f.write(data)


def generate(prompt: str) -> str:
    client = genai.Client(
        api_key=os.environ.get("GEMINI_API_KEY"),
    )

    model = "gemini-3-pro-image-preview"
    full_prompt = f"{prompt}. {DEFAULT_SUFFIX}"

    contents = [
        types.Content(
            role="user",
            parts=[
                types.Part.from_text(text=full_prompt),
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
        part = chunk.candidates[0].content.parts[0]
        if part.inline_data and part.inline_data.data:
            file_name = f"/tmp/story-image-{run_id}-{file_index}"
            file_index += 1
            inline_data = part.inline_data
            data_buffer = inline_data.data
            file_extension = mimetypes.guess_extension(inline_data.mime_type)
            saved_path = f"{file_name}{file_extension}"
            save_binary_file(saved_path, data_buffer)
            break
        else:
            if chunk.text:
                print(chunk.text)

    if not saved_path:
        raise SystemExit("No image data was returned by the model.")

    print(saved_path)
    return saved_path


def main():
    parser = argparse.ArgumentParser(description="Generate a story cover image.")
    parser.add_argument("prompt", help="Image prompt for the story cover.")
    args = parser.parse_args()
    generate(args.prompt)


if __name__ == "__main__":
    main()
