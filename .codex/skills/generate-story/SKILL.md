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
- `REPLICATE_API_TOKEN` for Replicate.
- `STORY_API_TOKEN` for the worker automation API.
- `STORY_API_BASE_URL` (optional). If not set, use `https://bedtimestories.bruce-hart.workers.dev`.

Use the following workflow exactly.

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
/mnt/c/Users/admin/Documents/Code/bedtimestories/.codex/skills/generate-story/scripts/next-open-date.py
```
Environment variables:
- `STORY_API_TOKEN` (required): story automation API token.
- `STORY_API_BASE_URL` (optional): defaults to `https://bedtimestories.bruce-hart.workers.dev`.
- `STORY_CALENDAR_DAYS` (optional): number of days to scan per request (default 365).

## Step 1: Write the story text (Markdown)
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

Grandpa is bald and clean shaven.

Trixie is a black cat with short legs, white paws, black chin, black face and a white chest.

Story format requirements:
- Plain text only (no Markdown).
- Do not include the title in the story content.
- Use short paragraphs separated by blank lines.
- Keep sentences short and easy to read.

## Step 2: Generate a cover image (Replicate)
Model: `google/nano-banana-pro`

Image requirements:
- Landscape, 16:9.
- Cartoon aesthetic.
- No text, letters, or signage.
- Only include characters relevant to the selected scene.
- Incorporate reference images as guidance when available.

Convert local reference images to data URIs for `image_input` (list up to 14). Example (Python):
```bash
python - <<'PY'
import base64, json, mimetypes, pathlib
paths = list(pathlib.Path("PATH_TO_FOLDER").glob("*.*"))
inputs = []
for p in paths:
    mime = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    data = base64.b64encode(p.read_bytes()).decode("ascii")
    inputs.append(f"data:{mime};base64,{data}")
print(json.dumps(inputs))
PY
```

If there are no reference images, set `image_input` to an empty list.

Create the image prediction:
```bash
curl -s https://api.replicate.com/v1/models/google/nano-banana-pro/predictions \
  -H "Authorization: Token $REPLICATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "prompt": "YOUR_IMAGE_PROMPT",
      "image_input": [DATA_URI_LIST],
      "aspect_ratio": "16:9",
      "resolution": "2K",
      "output_format": "jpg",
      "safety_filter_level": "block_only_high"
    }
  }'
```

Poll until `status` is `succeeded`:
```bash
curl -s https://api.replicate.com/v1/predictions/PREDICTION_ID \
  -H "Authorization: Token $REPLICATE_API_TOKEN"
```
Save the `output` URL when ready.

Alternate image model (use if nano-banana-pro fails):
- Model: `black-forest-labs/flux-1.1-pro`
- Aspect ratio: 3:2
- Output format: png
- Schema: https://replicate.com/black-forest-labs/flux-1.1-pro/api/schema

Create the Flux image prediction:
```bash
curl -s https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions \
  -H "Authorization: Token $REPLICATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "prompt": "YOUR_IMAGE_PROMPT",
      "aspect_ratio": "3:2",
      "output_format": "png"
    }
  }'
```

## Step 3: Generate a short video (Replicate)
Primary model: `pixverse/pixverse-v5`

Video requirements:
- 16:9 landscape.
- Cartoon aesthetic.
- No text or letters.
- Use the generated image as the `image` input for consistency.
- Use the story to build a concise scene prompt.
- Use 5 seconds, normal (effect `None`), 540p.

Create the PixVerse video prediction:
```bash
curl -s https://api.replicate.com/v1/models/pixverse/pixverse-v5/predictions \
  -H "Authorization: Token $REPLICATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "prompt": "YOUR_VIDEO_PROMPT",
      "image": "GENERATED_IMAGE_URL",
      "aspect_ratio": "16:9",
      "duration": 5,
      "quality": "540p",
      "effect": "None"
    }
  }'
```

Poll until `status` is `succeeded` and record the `output` URL.

Download the generated assets locally before uploading:
```bash
curl -L "IMAGE_OUTPUT_URL" -o /tmp/story-image.jpg
curl -L "VIDEO_OUTPUT_URL" -o /tmp/story-video.mp4
```

Re-encode the video for iPhone compatibility before uploading:
```bash
ffmpeg -y -i /tmp/story-video.mp4 \
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
    "content": "MARKDOWN_STORY",
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
