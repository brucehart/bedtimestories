# Bedtime Stories

This project is a small [Cloudflare Workers](https://developers.cloudflare.com/workers/) application for managing and serving short stories.  The worker exposes a minimal REST API backed by a D1 database and an R2 bucket for images and serves a React based frontend from the `public` directory.

Stories may be scheduled by specifying a future date when submitting. Scheduled stories are hidden from the main viewer until their publish date but remain accessible through the manage interface or by direct link.

## Requirements

- [Node.js](https://nodejs.org/) 18+
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

Create a D1 database with this structure:

```
CREATE TABLE stories (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  title     TEXT NOT NULL,
  content   TEXT NOT NULL,
  date      DATE NOT NULL,
  image_url TEXT,
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


## API Summary

The worker exposes the following endpoints:

- `GET /` – serves the story viewer
- `GET /submit` – serves a form to add a new story
- `GET /manage` – serves a page to edit or delete stories
- `GET /images/:key` – returns an image from the `IMAGES` bucket with long-term caching
- `GET /stories/list` – returns all stories in JSON
- `GET /stories` – returns the most recent story not scheduled for the future
- `GET /stories/:id` – returns a single story
- `POST /stories` – create a new story (multipart form data, fields: `title`, `content`, `date`, optional `image`)
- `PUT /stories/:id` – update an existing story (multipart form data, fields: `title`, `content`, `date`, optional `image`)
- `DELETE /stories/:id` – remove a story

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
