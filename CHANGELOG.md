# Changelog

All notable changes to this project are documented here. Release notes with more detail are available in `release-notes/`.

## [v1.0.4] — 2025-11-21
- Media delivery: add edge caching for `/images/*`, support byte-range/conditional requests, set canonical cache keys, and warm recent assets into `caches.default`.
- Reliability: scheduled cron now triggers cache warming; `CACHE_REFRESH_DAYS` exposed/configurable.
- Frontend polish: manage-link and paste-title improvements on the submit page.

See full notes: release-notes/v1.0.4.md

## [v1.0.3] — 2025-08-29
- Calendar UX: unified pop‑up calendar with story highlights; calendar API.
- Manage page: date search; show story date; local timezone display; retrieval aligned to Eastern time.
- Media: support story videos; serve images from internal path with long‑term cache headers; images resource.
- Auth/Access: centralized OAuth redirect; reader/editor roles; configurable public viewing; filter future stories.
- DB/Perf: calendar query uses index; index on `allowed_accounts`.
- Refactor: split worker into modules.
- Fixes: search icon alignment; video update handling; repeated declaration; `OAUTH_CALLBACK_URL`; hide image until loaded.
- Docs: add and update `AGENTS.md`.

See full notes: release-notes/v1.0.3.md

## [v1.0.2] — 2025-05-25
- Fix OAuth callback missing environment parameter.
- Add additional database indices for performance.

See full notes: release-notes/v1.0.2.md

## [v1.0.1] — 2025-05-24
- Auth/Security: long‑lived session JWT; HMAC key wiring; move to account secrets.
- Routing/Cache: refactor routing; disable caching for submit and edit pages.
- Database: add indices; add SQL for creating stories table.
- Fixes: secrets JSONC syntax; secret value call; formatting.
- Docs: expand README; document core functions.

See full notes: release-notes/v1.0.1.md

## [v1.0.0] — 2025-05-23
- Initial release: Cloudflare Worker scaffolding and routing; D1‑backed Stories API.
- Frontend: static pages (index, manage, submit, edit), story viewer with navigation.
- Features: pagination, search, edit page; Google OAuth; admin manage and submit flows.
- Fixes & polish: content rendering; navigation/date handling; config fixes; README and MIT License.

See full notes: release-notes/v1.0.0.md

---

Format inspired by Keep a Changelog. Dates are UTC.
