---
name: generate-story
description: Draft a new bedtime story.
metadata:
  short-description: Draft a new bedtime story.
---

# Generate Story (Codex)

You will be given:
- A story subject (prompt) for James.
- A folder path that may contain reference images and may include a date in the folder name.
- Optionally a markdown file name that may include a date.

Required environment variables:
- `GEMINI_API_KEY` for Google Vertex (Gemini). Must be exported in the current environment (dotfiles may not be sourced).
- `STORY_API_TOKEN` for the worker automation API.
- `STORY_API_BASE_URL` (optional). If not set, use `https://bedtimestories.bruce-hart.workers.dev`.

Activate the Python venv for any steps that run Python:
```bash
source ~/scripts/.venv/bin/activate
```

Use the following workflow exactly.

The image script prints the generated image path so it can be passed to the video script.

## Preflight (fail fast)
Before doing anything else, verify the required env vars exist in the *current* shell environment:
```bash
python -c 'import os; assert os.getenv("GEMINI_API_KEY"), "GEMINI_API_KEY missing"'
python -c 'import os; assert os.getenv("STORY_API_TOKEN"), "STORY_API_TOKEN missing"'
command -v ffmpeg >/dev/null
command -v curl >/dev/null
```

## Step 0: Resolve story date
1) If the folder name contains a `YYYY-MM-DD` date, use that.
2) Else if the markdown file name contains a `YYYY-MM-DD` date, use that.
3) Else find the next date (including today) that does not already have a story:
   - Use the story API token to query existing story days.
   - Fetch a range starting today through today + 365 days (extend the range if needed).
   - Pick the earliest date in that range that is not present in the calendar data.

Example:
```bash
START=$(date -u +%Y-%m-%d)
END=$(date -u -d "+365 days" +%Y-%m-%d)
curl -s "https://bedtimestories.bruce-hart.workers.dev/api/stories/calendar?start=$START&end=$END" \
  -H "X-Story-Token: $STORY_API_TOKEN"
```
The response includes `{ "days": [ { "day": "YYYY-MM-DD", "count": N }, ... ] }`.
Choose the first date starting at `START` that is missing from the `days` list.

Helper script:
```bash
STORY_API_TOKEN=... \
STORY_API_BASE_URL=https://bedtimestories.bruce-hart.workers.dev \
python .codex/skills/generate-story/scripts/next-open-date.py
```
Environment variables:
- `STORY_API_TOKEN` (required): story automation API token.
- `STORY_API_BASE_URL` (optional): defaults to `https://bedtimestories.bruce-hart.workers.dev`.
- `STORY_CALENDAR_DAYS` (optional): number of days to scan per request (default 365).
- `STORY_TIMEZONE` (optional): timezone used to interpret "today" (default `America/New_York`).

## Step 1: Write the story text (Markdown-compatible plain text)
Follow these instructions exactly:

For the given prompt, write a bedtime story including a title for my six year old son James. Make the text simple and phonics friendly for a beginning reader. Return the title separately and do not include it in the story content.

[Story Content]

In addition to Mom and Dad in his family, James has a three year old sister named Grace. He also has a small tuxedo cat named Trixie. In his family is also Granny and Grandpa Rick and Grandma and Grandpa Bruce. Only include people that are relevant to the story. Do not include people just to include them.

Do not use words in any image generated. Images should be in landscape format and have a cartoon aesthetic. Only include people in the images that are relevant to the scene of the story being visualized.

James has fair skin and short brown hair.

Mom has fair skin, shoulder length brown hair with blonde highlights and glasses.

Grace has long brown hair and fair skin.

Dad is bald and clean shaven with brown hair and thick dark eyebrows.

Granny is short with short gray hair.

Grandma has short blonde hair and glasses.

Grandpa Bruce is bald and clean shaven.

Grandpa Rick is bald, clean shaven and wears glasses.

Trixie is a black cat with short legs, white paws, black chin, black face and a white chest.

Story format requirements:
- Plain text paragraphs only. (Plain text with blank lines is valid Markdown; do not use Markdown formatting like headings/lists.)
- Do not include the title in the story content.
- Use short paragraphs separated by blank lines.
- Keep sentences short and easy to read.

## Recommended: One-command run (Steps 0,2,3,4,5)
After you have the title and story content, put the content in a file (example: `/tmp/story.txt`) and run:
```bash
source ~/scripts/.venv/bin/activate
python .codex/skills/generate-story/scripts/run-generate-story.py \
  --title "TITLE" \
  --content-file /tmp/story.txt
```
Optional flags:
- `--date YYYY-MM-DD` to force a specific date instead of auto-selecting next open date.
- `--story-id ID` to update an existing story's `image_url`/`video_url` (regenerates media, uploads it, then `PUT`s the keys).
- `--ref-image /path/to.jpg` (repeatable) to guide the cover image with reference photos.
- `--image-prompt "..."` / `--video-prompt "..."` to override the default media prompts.
- `--json` to print a single JSON object to stdout.

## Step 2: Generate a cover image (Google Vertex Gemini)
Model: `gemini-3-pro-image-preview`

Image requirements:
- Landscape, 16:9.
- 1K resolution.
- Cartoon aesthetic.
- No text, letters, or signage.
- Only include characters relevant to the selected scene.
- Incorporate reference images as guidance when available (describe them in the prompt).

Note: `run-generate-story.py` derives safe default image/video prompts from the provided `--title` and `--content-file` so it doesn't accidentally reuse a previous story theme. You can still override prompts explicitly with `--image-prompt` / `--video-prompt`.

Install dependency:
```bash
pip install google-genai
```

If reference images are available, pass one or more with repeated `--image` flags.

Generate and save the image locally (example with optional reference images):
```bash
IMAGE_PATH=$(python .codex/skills/generate-story/scripts/generate-image.py \
  --image "/path/to/reference-1.jpg" \
  --image "/path/to/reference-2.png" \
  "YOUR_IMAGE_PROMPT")
```

The script saves the image(s) under `/tmp` and prints the first image path as output.
Use the saved image file (e.g., the value in `$IMAGE_PATH`) for upload and as input to the video step.

## Step 3: Generate a short video (Google Vertex Veo)
Model: `veo-3.1-fast-generate-preview`

Video requirements:
- 16:9 landscape.
- 8 seconds.
- 24 fps.
- Cartoon aesthetic.
- No text or letters.
- Use the story to build a concise scene prompt.
- Use the generated cover image as a visual reference in the video request.
Note: `frame_rate` is not accepted by the current `GenerateVideosConfig` schema. Keep 24 fps in the prompt instead.

Install dependency:
```bash
pip install google-genai pillow
```

Generate and save the video locally (example):
```bash
VIDEO_PATH=$(python .codex/skills/generate-story/scripts/generate-video.py \
  "$IMAGE_PATH" \
  "YOUR_VIDEO_PROMPT")
```

Use the saved video file (e.g., the value in `$VIDEO_PATH`) for upload.

Re-encode the video for iPhone compatibility before uploading:
```bash
ffmpeg -y -i "$VIDEO_PATH" \
  -c:v libx264 -profile:v high -level 4.0 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -movflags +faststart \
  /tmp/story-video-encoded.mp4
```

## Step 4: Upload media to R2 via worker API
Base URL:
- If `STORY_API_BASE_URL` is set, use that.
- Else use `https://bedtimestories.bruce-hart.workers.dev`.

Upload image:
```bash
curl -s "$STORY_API_BASE_URL/api/media" \
  -H "X-Story-Token: $STORY_API_TOKEN" \
  -F "file=@/path/to/image.jpg"
```

Upload video:
```bash
curl -s "$STORY_API_BASE_URL/api/media" \
  -H "X-Story-Token: $STORY_API_TOKEN" \
  -F "file=@/tmp/story-video-encoded.mp4"
```

Each response returns `{ "key": "..." }`. Keep those keys.

## Step 5: Create the story record
Send the story to the worker:
```bash
curl -s "$STORY_API_BASE_URL/api/stories" \
  -H "X-Story-Token: $STORY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "TITLE",
    "content": "STORY_CONTENT",
    "date": "YYYY-MM-DD",
    "image_url": "IMAGE_KEY",
    "video_url": "VIDEO_KEY"
  }'
```

## Final output to user
Return:
- Title
- Story content (plain text)
- Image key
- Video key
- Story id
