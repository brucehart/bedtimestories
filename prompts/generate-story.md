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
3) Else use the current date in `YYYY-MM-DD`.

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
Primary model: `google/veo-3-fast`

Video requirements:
- 16:9 landscape.
- Cartoon aesthetic.
- No text or letters.
- Use the generated image as the `image` input for consistency.
- Use the story to build a concise scene prompt.

Create the video prediction:
```bash
curl -s https://api.replicate.com/v1/models/google/veo-3-fast/predictions \
  -H "Authorization: Token $REPLICATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "prompt": "YOUR_VIDEO_PROMPT",
      "image": "GENERATED_IMAGE_URL",
      "aspect_ratio": "16:9",
      "duration": 8,
      "resolution": "1080p",
      "generate_audio": false
    }
  }'
```

Poll until `status` is `succeeded` and record the `output` URL.

If Veo fails (status `failed` or sensitive content error), fall back to PixVerse:
- Model: `pixverse/pixverse-v5`
- Use 8 seconds, normal (effect `None`), 540p.

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
      "duration": 8,
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
  -F "file=@/path/to/video.mp4"
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
