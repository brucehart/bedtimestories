---
name: generate-story
description: Generate and publish a bedtime story for James with consistent text, cover art, and video.
metadata:
  short-description: Generate and publish a bedtime story for James.
---

# Generate Story (Codex)

Use this skill when the user wants a new bedtime story for James or wants to refresh media for an existing story.

## Input contract

Expect some combination of:
- A freeform story prompt or source material.
- Zero or more reference image paths.
- Optionally a target date (`YYYY-MM-DD`).
- Optionally a story id when updating an existing record.

If the user provides a long synopsis, movie plot, or article-like background, treat it as inspiration only. Do not retell it beat-by-beat.

## Output contract

Always return:
- `title`
- `story_content`
- `image_key`
- `video_key`
- `story_id`

When relevant, also return the resolved `date`.

## Required environment

Required env vars:
- `REPLICATE_API_TOKEN`
- `STORY_API_TOKEN`
- `STORY_API_BASE_URL` (optional, defaults to `https://bedtimestories.bruce-hart.workers.dev`)

For any Python step, activate the venv first:

```bash
source ~/scripts/.venv/bin/activate
```

## Fast path

Prefer this path unless blocked:
1. Preflight.
2. Resolve the story date.
3. Write title and story content.
4. Save the content to a temp file.
5. Run `run-generate-story.py`.

Use the manual image/video/upload steps only if the runner cannot satisfy the task.

## Preflight

Run this first:

```bash
source ~/scripts/.venv/bin/activate
python -c 'import os; assert os.getenv("REPLICATE_API_TOKEN"), "REPLICATE_API_TOKEN missing"'
python -c 'import os; assert os.getenv("STORY_API_TOKEN"), "STORY_API_TOKEN missing"'
command -v ffmpeg >/dev/null
command -v curl >/dev/null
```

## Step 0: Resolve story date

Use this order:
1. If the user explicitly gives a date, use it.
2. Else if an input folder name contains `YYYY-MM-DD`, use that.
3. Else if an input markdown file name contains `YYYY-MM-DD`, use that.
4. Else pick the next open date, starting with today in `America/New_York`.

Preferred helper:

```bash
source ~/scripts/.venv/bin/activate
python .codex/skills/generate-story/scripts/next-open-date.py
```

Relevant env vars:
- `STORY_API_TOKEN` required
- `STORY_API_BASE_URL` optional
- `STORY_CALENDAR_DAYS` optional, default `365`
- `STORY_TIMEZONE` optional, default `America/New_York`

## Step 1: Write the story

Write a bedtime story for James.

Hard requirements:
- Return the title separately.
- Do not include the title in `story_content`.
- Use plain text paragraphs only.
- No headings, bullets, or markdown decoration in the story body.
- Default target length: `180-260` words.
- Default target structure: `8-14` short paragraphs.
- Use short, phonics-friendly sentences for a beginning reader.
- End with a calm, safe feeling.

## Source adaptation rules

If the user provides complex source material:
- Extract only `1-3` child-friendly ideas.
- Prefer one simple adventure or dream arc.
- Do not reproduce the full plot.
- Remove or soften death, murder, assassination, terror, political conflict, mind control, disaster, and other intense material unless the user clearly asks to keep it.
- Bias toward wonder, helping, friendship, bravery, problem-solving, and a gentle ending.

## Character rules

Only include people or pets that matter to the specific story.

Reference details:
- James: fair skin, short brown hair.
- Mom: fair skin, shoulder-length brown hair with blonde highlights, glasses.
- Dad: bald, clean shaven, brown hair, thick dark eyebrows.
- Grace: three years old, long brown hair, fair skin.
- Granny: short, short gray hair.
- Grandma: short blonde hair, glasses.
- Grandpa Bruce: bald, clean shaven.
- Grandpa Rick: bald, clean shaven, glasses.
- Trixie: small tuxedo cat with short legs, white paws, black chin, black face, white chest.

## Media rules

Image requirements:
- Landscape `16:9`
- Cartoon aesthetic
- No text, letters, or signage
- Only include characters relevant to the selected scene

Video requirements:
- Landscape `16:9`
- `5` seconds
- Cartoon aesthetic
- No text or letters
- Use the generated image as the visual reference
- Keep the action simple and readable

## Media prompt guidance

Keep prompts short and scene-specific.

Image prompt template:

```text
Landscape 16:9 cartoon bedtime scene. {scene}. Include only {relevant_characters}. Warm storybook mood. No text, letters, or signage.
```

Video prompt template:

```text
Gentle cartoon motion scene: {action}. Keep it cozy, readable, and simple. No text or letters.
```

Do not dump the whole story into the media prompt. Use one scene only.

## Preferred command: new story

After writing the story, save the body to a temp file such as `/tmp/story.txt`, then run:

```bash
source ~/scripts/.venv/bin/activate
python .codex/skills/generate-story/scripts/run-generate-story.py \
  --title "TITLE" \
  --content-file /tmp/story.txt \
  --date YYYY-MM-DD \
  --ref-image /path/to/reference-image
```

Useful flags:
- `--date YYYY-MM-DD` to force a date
- `--ref-image /path/to.jpg` repeatable
- `--image-prompt "..."` to override the default image prompt
- `--video-prompt "..."` to override the default video prompt
- `--json` for machine-readable output

## Preferred command: update existing story media

Use this when the user wants to keep the story record but regenerate media:

```bash
source ~/scripts/.venv/bin/activate
python .codex/skills/generate-story/scripts/run-generate-story.py \
  --title "TITLE" \
  --content-file /tmp/story.txt \
  --story-id ID \
  --ref-image /path/to/reference-image
```

This regenerates media, uploads it, and updates `image_url` and `video_url` for the existing record.

## Manual fallback

Use the manual path only if the runner is not suitable.

Generate image:

```bash
source ~/scripts/.venv/bin/activate
IMAGE_PATH=$(python .codex/skills/generate-story/scripts/generate-image.py \
  --image "/path/to/reference.jpg" \
  "IMAGE_PROMPT")
```

Generate video:

```bash
source ~/scripts/.venv/bin/activate
VIDEO_PATH=$(python .codex/skills/generate-story/scripts/generate-video.py \
  "$IMAGE_PATH" \
  "VIDEO_PROMPT")
```

Re-encode for iPhone compatibility:

```bash
ffmpeg -y -i "$VIDEO_PATH" \
  -c:v libx264 -profile:v high -level 4.0 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -movflags +faststart \
  /tmp/story-video-encoded.mp4
```

Upload media:

```bash
curl -s "${STORY_API_BASE_URL:-https://bedtimestories.bruce-hart.workers.dev}/api/media" \
  -H "X-Story-Token: $STORY_API_TOKEN" \
  -F "file=@/path/to/image.jpg"
```

```bash
curl -s "${STORY_API_BASE_URL:-https://bedtimestories.bruce-hart.workers.dev}/api/media" \
  -H "X-Story-Token: $STORY_API_TOKEN" \
  -F "file=@/tmp/story-video-encoded.mp4"
```

Create story:

```bash
curl -s "${STORY_API_BASE_URL:-https://bedtimestories.bruce-hart.workers.dev}/api/stories" \
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

## Final checklist

Before finishing, verify:
- The story is short, simple, and bedtime-safe.
- The title is separate from the body.
- The body is plain text paragraphs only.
- Only relevant characters appear in the story and media prompts.
- Media prompts describe one scene, not the whole story.
- The date is resolved.
- The final response includes title, story content, image key, video key, and story id.
