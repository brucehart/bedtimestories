# Bedtime Stories

This project is a small [Cloudflare Workers](https://developers.cloudflare.com/workers/) application for managing and serving short stories.  The worker exposes a minimal REST API backed by a D1 database and an R2 bucket for images and serves a React based frontend from the `public` directory.

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
npm run dev
```

The application will be available at `http://localhost:8787`.

## Deployment

Deploy the worker to Cloudflare with:

```bash
npm run deploy
```

This uses the configuration defined in `wrangler.jsonc` which binds:

- `DB` – a D1 database named `bedtime-stories`
- `IMAGES` – an R2 bucket named `story-images`
- `ASSETS` – static files from the `public` directory

Ensure these resources exist in your Cloudflare account before deploying.

## Testing

Unit tests are written with [Vitest](https://vitest.dev/). Run the test suite with:

```bash
npm test
```

## API Summary

The worker exposes the following endpoints:

- `GET /` – serves the story viewer
- `GET /submit` – serves a form to add a new story
- `GET /manage` – serves a page to edit or delete stories
- `GET /stories/list` – returns all stories in JSON
- `GET /stories` – returns the most recent story
- `GET /stories/:id` – returns a single story
- `POST /stories` – create a new story (multipart form data)
- `PUT /stories/:id` – update an existing story (multipart form data)
- `DELETE /stories/:id` – remove a story

## License

This project is provided without a specific license.
