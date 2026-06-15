![Bedtime Stories Icon](public/bedtime-stories-icon.png)

# Bedtime Stories

This project is a small [Cloudflare Workers](https://developers.cloudflare.com/workers/) application for managing and serving short stories.  The worker exposes a REST API backed by a D1 database and an R2 bucket for story media and serves a React based frontend from the `public` directory.

Stories may be scheduled by specifying a future date when submitting. Scheduled stories are hidden from the main viewer until their publish date but remain accessible through the manage interface or by direct link.

## Features

- Public story viewer with scheduled publishing, previous/next navigation, and optional image or video playback.
- Editor-only submit, edit, and manage pages with search, date filtering, calendar highlights, and R2-backed media uploads.
- Google OAuth access control with `reader` and `editor` roles, plus optional public viewing through `PUBLIC_VIEW`.
- Edge-cached media delivery for images and videos, including byte-range and conditional request support.
- Header-authenticated automation APIs for calendar lookup, media upload, and story create/update workflows.
- Codex story generation workspace at `/generate-story`, launched from `/manage`, with Sprite-backed jobs, reference images, live logs, feedback messages, cancellation, and review links.

## Requirements

- [Node.js](https://nodejs.org/) 20+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) CLI

## Installation

Install the dependencies once using npm:

```bash
npm install
```

## Development

Start a local development server using Wrangler:

```bash
wrangler dev
```

The application will be available at `http://localhost:8787`.

## Database 

Create a D1 database with this structure. The matching schema files are in
`db/stories_table.sql` and `db/allowed_accounts_table.sql`.

```
CREATE TABLE stories (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  title     TEXT NOT NULL,
  content   TEXT NOT NULL,
  date      DATE NOT NULL,
  image_url TEXT,
  video_url TEXT,
  created   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_stories_date ON stories (date DESC);
CREATE INDEX idx_stories_title_content ON stories(title, content);
CREATE INDEX idx_stories_id ON stories(id);

CREATE TABLE allowed_accounts (
  email TEXT PRIMARY KEY,
  role  TEXT NOT NULL DEFAULT 'editor'
);
```

Agentic story generation from `/manage` and `/generate-story` also requires the
tables in `db/story_agent_tables.sql`.

## Deployment

Deploy the worker to Cloudflare with:

```bash
wrangler deploy
```

This uses the configuration defined in `wrangler.jsonc` which binds:

- `DB` – a D1 database named `bedtime-stories`
- `IMAGES` – an R2 bucket named `story-images`
- `ASSETS` – static files from the `public` directory

Ensure these resources exist in your Cloudflare account before deploying.

### Authentication

Access to the worker is protected using Google OAuth. Permitted accounts are
listed in the `allowed_accounts` table of the D1 database along with a `role`
value of either `reader` or `editor`. Readers can only view stories while
editors may add, modify or delete them. Add or remove rows from this table to
manage access. If the table is empty, any account is permitted as an editor.
The Google OAuth client credentials should be stored as secrets named
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### Story Automation API

The bundled `generate-story` skill and Sprite runner use a header-authenticated
automation API. Set `STORY_API_TOKEN` as a Worker secret and send it in
`X-Story-Token`.

- `GET /api/stories/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD` returns days with scheduled stories for date selection.
- `POST /api/media` accepts `multipart/form-data` with a `file` field, stores an image or video in R2, and returns the media key.
- `POST /api/stories` accepts JSON with `title`, `content` (Markdown), optional `date`, and optional `image_url` / `video_url` R2 keys.
- `PUT /api/stories/:id` accepts partial JSON updates for `title`, `content`, `date`, `image_url`, and `video_url`.

### Codex Story Generation

The `/manage` page links to `/generate-story`, where editors can launch
story-generation jobs in a preconfigured Sprite. Story ideas may include an
optional target date and up to three reference images selected from a file
picker or pasted into the prompt field. The page shows recent jobs, streams
runner logs with SSE, accepts feedback while the job is running, can cancel
active jobs, and links completed jobs back to the generated story.

Apply `db/story_agent_tables.sql`, keep the `bedtime-stories` Sprite updated
with the project and `generate-story` skill, and configure these Worker secrets:

- `SPRITES_API_TOKEN` – Sprites API token used by the Worker to start commands.
- `STORY_AGENT_ALLOWED_EMAILS` – comma-separated editor emails allowed to run costly agent jobs.
- `STORY_API_TOKEN` – existing story automation token used by the Sprite runner.

Optional vars:

- `STORY_AGENT_SPRITE_NAME` – defaults to `bedtime-stories`.
- `STORY_AGENT_SPRITE_WORKDIR` – defaults to `/home/sprite/bedtimestories/main`.
- `STORY_AGENT_SPRITES_API_BASE` – defaults to `https://api.sprites.dev`.
- `STORY_API_USER_AGENT` – browser-like user agent used by Sprite-side story API calls; override only if Cloudflare Browser Integrity Check starts blocking the default.

The runner creates a Sprite task hold while Codex is actively generating a story,
refreshes it during the run, and releases it when the job completes or fails.
Canceling a job also asks the Sprite to terminate the runner and delete that
task hold, making the Sprite eligible to pause when idle.
When reference images are included, the Worker stores them in R2, the runner
downloads them into `/tmp` on the Sprite, attaches them to Codex, and instructs
Codex to pass each path to `generate-story` as `--ref-image`.
If Sprite logs show Cloudflare Error 1010 (`browser_signature_banned`) on
`/api/agent` callbacks, deploy the current Worker code so the runner uses the
browser-like user agent. If the account-level security rule still blocks the
Sprite, disable Browser Integrity Check selectively for the authenticated
automation API paths rather than disabling story-agent authentication.

### Security Notes

- If `allowed_accounts` is empty, any Google account is treated as an `editor` (intentionally retained behavior; increases risk if the database is ever cleared).
- The admin UI currently loads React from `unpkg.com` and uses inline scripts. This is a supply-chain risk (a compromised CDN response could perform authenticated actions). Recommended hardening is to self-host dependencies and move inline scripts into local JS files, then enforce a strict CSP.
- `GET /update-cache` requires `CACHE_REFRESH_TOKEN` (Bearer auth). Do not deploy without setting it.
- Story-generation jobs require both an editor session and `STORY_AGENT_ALLOWED_EMAILS`; leave the allowlist unset to disable this high-cost surface.

## API Summary

The worker exposes the following endpoints:

- `GET /` – serves the story viewer
- `GET /submit` – serves a form to add a new story
- `GET /manage` – serves a page to edit or delete stories
- `GET /generate-story` – serves the Codex story generation workspace
- `GET /update-cache` – warms recent media into `caches.default` with Bearer `CACHE_REFRESH_TOKEN`
- `GET /images/:key` – returns image or video media from the `IMAGES` bucket with long-term caching
- `GET /stories/list` – returns all stories in JSON
- `GET /stories/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD` – returns days with at least one story between the dates for calendar highlighting
- `GET /stories` – returns the most recent story not scheduled for the future
- `GET /stories/:id` – returns a single story
- `POST /stories` – create a new story (multipart form data, fields: `title`, `content`, `date`, optional `image`, optional `video`)
- `PUT /stories/:id` – update an existing story (multipart form data, fields: `title`, `content`, `date`, optional `image`, optional `video`)
- `DELETE /stories/:id` – remove a story
- `GET /agent/jobs` – list recent story-generation jobs for the authenticated editor
- `POST /agent/jobs` – create an authenticated story-generation job
- `GET /agent/jobs/:id` – return one story-generation job
- `GET /agent/jobs/:id/events` – replay job events as an SSE stream
- `POST /agent/jobs/:id/messages` – queue feedback for the running job
- `POST /agent/jobs/:id/cancel` – cancel an active story-generation job
- `POST /api/media`, `POST /api/stories`, `PUT /api/stories/:id`, `GET /api/stories/calendar` – token-authenticated automation endpoints

## License

This project is licensed under the [MIT License](LICENSE).

```
MIT License

Copyright (c) 2024 Bruce J. Hart

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished
