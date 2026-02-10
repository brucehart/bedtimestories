import { AuthInfo, Env, Route, Story } from './types';
import { markdownToHtml, easternNowIso, htmlToPlainText } from './utils';
import { signSession, signState, verifyState, verifySession, SESSION_MAXAGE } from './session';
import { verifyGoogleToken, getAccountRole, requireAuth } from './auth';

const CACHE_REFRESH_DEFAULT_DAYS = 5;
const CACHE_REFRESH_MAX_DAYS = 30;

const CACHE_KEY_PREFIX = 'https://bedtimestories.bruce-hart.workers.dev';
const STORY_TOKEN_HEADER = 'X-Story-Token';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

const MAX_MEDIA_KEY_LENGTH = 200;
const MEDIA_KEY_RE = /^[A-Za-z0-9._-]+$/;

const MAX_QUERY_LENGTH = 200;
const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 50_000;

const CONTENT_TYPE_EXTENSION: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov'
};

function buildCacheRequest(path: string): Request {
    return new Request(`${CACHE_KEY_PREFIX}${path}`, { method: 'GET' });
}

function buildConditionalHeaders(request: Request): Headers | undefined {
    const conditionalNames = [
        'if-match',
        'if-none-match',
        'if-modified-since',
        'if-unmodified-since',
        'if-range'
    ];
    const headers = new Headers();
    let any = false;
    for (const name of conditionalNames) {
        const value = request.headers.get(name);
        if (value) {
            headers.set(name, value);
            any = true;
        }
    }
    return any ? headers : undefined;
}

function requireStoryToken(request: Request, env: Env): Response | null {
    const requiredToken = env.STORY_API_TOKEN;
    if (!requiredToken) {
        return new Response('Story API token not configured', { status: 503 });
    }
    const providedToken = request.headers.get(STORY_TOKEN_HEADER);
    if (!providedToken || providedToken !== requiredToken) {
        return new Response('Unauthorized', { status: 401 });
    }
    return null;
}

function getContentTypeExtension(contentType: string): string {
    const normalized = contentType.toLowerCase();
    return CONTENT_TYPE_EXTENSION[normalized] ?? '';
}

function validateMediaKey(key: string): boolean {
    if (!key) return false;
    if (key.length > MAX_MEDIA_KEY_LENGTH) return false;
    return MEDIA_KEY_RE.test(key);
}

function applyHtmlSecurityHeaders(headers: Headers, options?: { cacheNoStore?: boolean }) {
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    // Keep inline scripts working; only lock down embedding/object/base behavior.
    headers.set(
        'Content-Security-Policy',
        "frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
    );
    if (options?.cacheNoStore) {
        headers.set('Cache-Control', 'no-store');
    }
}

function applyNoStoreNoReferrer(headers: Headers) {
    headers.set('Cache-Control', 'no-store');
    headers.set('Referrer-Policy', 'no-referrer');
}

type UploadKind = 'image' | 'video' | 'either';

function validateUpload(file: File, kind: UploadKind): Response | null {
    const contentType = (file.type || '').toLowerCase();
    const isImage = ALLOWED_IMAGE_TYPES.has(contentType);
    const isVideo = ALLOWED_VIDEO_TYPES.has(contentType);

    if (kind === 'image' && !isImage) return new Response('Unsupported Media Type', { status: 415 });
    if (kind === 'video' && !isVideo) return new Response('Unsupported Media Type', { status: 415 });
    if (kind === 'either' && !isImage && !isVideo) return new Response('Unsupported Media Type', { status: 415 });

    const limit = isImage ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
    if (file.size > limit) return new Response('Payload Too Large', { status: 413 });

    const ext = getContentTypeExtension(contentType);
    if (!ext) return new Response('Unsupported Media Type', { status: 415 });
    return null;
}

function normalizeStoryDate(value: string | undefined): string {
    const trimmed = value?.trim();
    if (trimmed) {
        const parsed = new Date(trimmed);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }
    }
    return new Date().toISOString();
}

function withContentText(story: Story) {
    return {
        ...story,
        content_text: htmlToPlainText(story.content)
    };
}

async function warmRecentAssets(env: Env, days: number) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { results } = await env.DB.prepare(
        "SELECT image_url, video_url FROM stories WHERE date >= ?1 ORDER BY date DESC"
    )
        .bind(cutoff)
        .all<{ image_url: string | null; video_url: string | null }>();
    const assetKeys = new Set<string>();
    for (const row of results) {
        if (row.image_url) assetKeys.add(row.image_url);
        if (row.video_url) assetKeys.add(row.video_url);
    }
    const missing: string[] = [];
    let warmed = 0;
    const cache = caches.default;
    for (const key of assetKeys) {
        try {
            const object = await env.IMAGES.get(key);
            if (!object) {
                missing.push(key);
                continue;
            }
            const headers = new Headers();
            object.writeHttpMetadata(headers);
            headers.set('etag', object.httpEtag);
            headers.set('Cache-Control', 'public, max-age=31536000, immutable');
            const cacheReq = buildCacheRequest(`/images/${encodeURIComponent(key)}`);
            const cacheRes = new Response(object.body, { status: 200, headers });
            await cache.put(cacheReq, cacheRes);
            warmed++;
        } catch {
            missing.push(key);
        }
    }
    return { total: assetKeys.size, warmed, missing };
}

// Routes for login flow and OAuth callback
const preAuthRoutes: Route[] = [
    {
        method: 'GET',
        pattern: /^\/update-cache$/,
        handler: async (request, env, _ctx, _match, url) => {
            const requiredToken = env.CACHE_REFRESH_TOKEN;
            if (!requiredToken) return new Response('Cache refresh token not configured', { status: 503 });
            const authHeader = request.headers.get('Authorization');
            if (authHeader !== `Bearer ${requiredToken}`) {
                return new Response('Forbidden', { status: 403 });
            }
            const daysParam = url.searchParams.get('days');
            let days = CACHE_REFRESH_DEFAULT_DAYS;
            if (daysParam !== null) {
                const parsed = Number(daysParam);
                if (!Number.isFinite(parsed) || parsed <= 0) {
                    return new Response('Invalid days parameter', { status: 400 });
                }
                days = Math.min(Math.floor(parsed), CACHE_REFRESH_MAX_DAYS);
            }
            try {
                const result = await warmRecentAssets(env, days);
                return Response.json(
                    {
                        days,
                        assetsConsidered: result.total,
                        warmed: result.warmed,
                        missing: result.missing
                    },
                    { headers: { 'Cache-Control': 'no-store' } }
                );
            } catch {
                return new Response('Internal Error', { status: 500 });
            }
        }
    },
    {
        method: 'GET',
        pattern: /^\/api\/stories\/calendar$/,
        handler: async (request, env) => {
            const authError = requireStoryToken(request, env);
            if (authError) return authError;
            try {
                const url = new URL(request.url);
                const startParam = url.searchParams.get('start');
                const endParam = url.searchParams.get('end');
                if (!startParam || !endParam) {
                    return new Response('Missing start or end', { status: 400 });
                }

                const startDay = new Date(startParam);
                const endDay = new Date(endParam);
                if (isNaN(startDay.getTime()) || isNaN(endDay.getTime())) {
                    return new Response('Invalid date range', { status: 400 });
                }

                const start = startDay.toISOString().slice(0, 10);
                const endExclusive = new Date(endDay);
                endExclusive.setDate(endExclusive.getDate() + 1);
                const end = endExclusive.toISOString().slice(0, 10);

                const stmt = env.DB.prepare(
                    "SELECT substr(date,1,10) AS day, COUNT(*) AS count \
                    FROM stories \
                    WHERE date >= ?1 AND date < ?2 \
                    GROUP BY day \
                    ORDER BY day"
                ).bind(start, end);

                const { results } = await stmt.all<{ day: string; count: number }>();
                return Response.json({ days: results });
            } catch {
                return new Response('Server error', { status: 500 });
            }
        }
    },
    {
        method: 'POST',
        pattern: /^\/api\/media$/,
        handler: async (request, env) => {
            const authError = requireStoryToken(request, env);
            if (authError) return authError;
            if (!request.headers.get('content-type')?.includes('multipart/form-data')) {
                return new Response('Expected multipart/form-data', { status: 400 });
            }
            const data = await request.formData();
            const file = data.get('file');
            if (!(file instanceof File)) {
                return new Response('Missing file', { status: 400 });
            }
            const uploadError = validateUpload(file, 'either');
            if (uploadError) return uploadError;
            const ext = getContentTypeExtension(file.type);
            const key = crypto.randomUUID() + ext;
            await env.IMAGES.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
            return Response.json({ key, url: `/images/${encodeURIComponent(key)}` });
        }
    },
    {
        method: 'POST',
        pattern: /^\/api\/stories$/,
        handler: async (request, env) => {
            const authError = requireStoryToken(request, env);
            if (authError) return authError;
            if (!request.headers.get('content-type')?.includes('application/json')) {
                return new Response('Expected application/json', { status: 400 });
            }
            const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
            if (!payload || typeof payload !== 'object') {
                return new Response('Invalid JSON payload', { status: 400 });
            }
            const title = payload.title;
            const contentMd = payload.content;
            const dateStr = payload.date;
            const imageUrl = payload.image_url;
            const videoUrl = payload.video_url;
            if (typeof title !== 'string' || typeof contentMd !== 'string') {
                return new Response('Invalid story payload', { status: 400 });
            }
            const trimmedTitle = title.trim();
            const trimmedContent = contentMd.trim();
            if (!trimmedTitle || !trimmedContent) {
                return new Response('Missing title or content', { status: 400 });
            }
            const contentHtml = markdownToHtml(trimmedContent);
            const dateIso = normalizeStoryDate(typeof dateStr === 'string' ? dateStr : undefined);
            const imageKey = typeof imageUrl === 'string' && imageUrl.trim() ? imageUrl.trim() : null;
            const videoKey = typeof videoUrl === 'string' && videoUrl.trim() ? videoUrl.trim() : null;
            try {
                const stmt = env.DB.prepare(
                    'INSERT INTO stories (title, content, date, image_url, video_url, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, datetime(\'now\'), datetime(\'now\'))'
                ).bind(trimmedTitle, contentHtml, dateIso, imageKey, videoKey);
                const result = await stmt.run();
                return Response.json({ id: result.meta.last_row_id });
            } catch {
                return new Response('Internal Error', { status: 500 });
            }
        }
    },
    {
        method: 'PUT',
        pattern: /^\/api\/stories\/(\d+)$/,
        handler: async (request, env, _ctx, match) => {
            const authError = requireStoryToken(request, env);
            if (authError) return authError;
            if (!request.headers.get('content-type')?.includes('application/json')) {
                return new Response('Expected application/json', { status: 400 });
            }
            const id = Number(match[1]);
            if (!Number.isInteger(id)) {
                return new Response('Invalid story id', { status: 400 });
            }
            const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
            if (!payload || typeof payload !== 'object') {
                return new Response('Invalid JSON payload', { status: 400 });
            }
            const existing = await env.DB.prepare('SELECT * FROM stories WHERE id = ?1').bind(id).first<Story>();
            if (!existing) {
                return new Response('Not Found', { status: 404 });
            }

            const updates: { field: string; value: string | null }[] = [];
            let nextImageUrl: string | null | undefined;
            let nextVideoUrl: string | null | undefined;
            if ('title' in payload) {
                if (typeof payload.title !== 'string') return new Response('Invalid title', { status: 400 });
                const trimmed = payload.title.trim();
                if (!trimmed) return new Response('Missing title', { status: 400 });
                updates.push({ field: 'title', value: trimmed });
            }
            if ('content' in payload) {
                if (typeof payload.content !== 'string') return new Response('Invalid content', { status: 400 });
                const trimmed = payload.content.trim();
                if (!trimmed) return new Response('Missing content', { status: 400 });
                updates.push({ field: 'content', value: markdownToHtml(trimmed) });
            }
            if ('date' in payload) {
                if (typeof payload.date !== 'string') return new Response('Invalid date', { status: 400 });
                updates.push({ field: 'date', value: normalizeStoryDate(payload.date) });
            }
            if ('image_url' in payload) {
                if (payload.image_url !== null && typeof payload.image_url !== 'string') {
                    return new Response('Invalid image_url', { status: 400 });
                }
                const trimmed = typeof payload.image_url === 'string' ? payload.image_url.trim() : '';
                nextImageUrl = trimmed ? trimmed : null;
                updates.push({ field: 'image_url', value: nextImageUrl });
            }
            if ('video_url' in payload) {
                if (payload.video_url !== null && typeof payload.video_url !== 'string') {
                    return new Response('Invalid video_url', { status: 400 });
                }
                const trimmed = typeof payload.video_url === 'string' ? payload.video_url.trim() : '';
                nextVideoUrl = trimmed ? trimmed : null;
                updates.push({ field: 'video_url', value: nextVideoUrl });
            }

            if (updates.length === 0) {
                return new Response('No updates provided', { status: 400 });
            }

            const setParts: string[] = [];
            const params: (string | number | null)[] = [];
            for (const update of updates) {
                setParts.push(`${update.field} = ?${params.length + 1}`);
                params.push(update.value);
            }
            setParts.push("updated = datetime('now')");
            params.push(id);
            const stmt = env.DB.prepare(
                `UPDATE stories SET ${setParts.join(', ')} WHERE id = ?${params.length}`
            );
            await stmt.bind(...params).run();

            // Best-effort cleanup: if media keys changed, delete the old objects from R2 to prevent orphans.
            // (No-op if the object doesn't exist or delete fails.)
            try {
                if (nextImageUrl !== undefined && existing.image_url && existing.image_url !== nextImageUrl) {
                    await env.IMAGES.delete(existing.image_url);
                }
            } catch {
                // ignore
            }
            try {
                if (nextVideoUrl !== undefined && existing.video_url && existing.video_url !== nextVideoUrl) {
                    await env.IMAGES.delete(existing.video_url);
                }
            } catch {
                // ignore
            }

            return Response.json({ id });
        }
    },
    {
        method: 'GET',
        pattern: /^\/login$/,
        handler: async (_request, env, _ctx, _match, url) => {
            const redirectUri = env.OAUTH_CALLBACK_URL;
            const state = await signState(url.origin, env);
            const params = new URLSearchParams({
                client_id: env.GOOGLE_CLIENT_ID,
                redirect_uri: redirectUri,
                response_type: 'code',
                scope: 'openid email',
                prompt: 'select_account',
                state
            });
            const headers = new Headers({
                Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString()
            });
            applyNoStoreNoReferrer(headers);
            return new Response(null, { status: 302, headers });
        }
    },
    {
        method: 'GET',
        pattern: /^\/oauth\/callback$/,
        handler: async (_request, env, _ctx, _match, url) => {
            const tokenParam = url.searchParams.get('token');
            if (tokenParam) {
                const email = await verifySession(tokenParam, env);
                if (!email) return new Response('Invalid token', { status: 400 });
                const headers = new Headers({
                    Location: '/',
                    'Set-Cookie': `session=${tokenParam}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAXAGE}`
                });
                applyNoStoreNoReferrer(headers);
                return new Response(null, {
                    status: 302,
                    headers
                });
            }

            const code = url.searchParams.get('code');
            if (!code) return new Response('Missing code', { status: 400 });
            const state = url.searchParams.get('state');
            const returnTo = state ? await verifyState(state, env).catch(() => null) : null;
            if (!returnTo) return new Response('Invalid state', { status: 400 });
            const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                body: new URLSearchParams({
                    code,
                    client_id: env.GOOGLE_CLIENT_ID,
                    client_secret: env.GOOGLE_CLIENT_SECRET,
                    redirect_uri: env.OAUTH_CALLBACK_URL,
                    grant_type: 'authorization_code'
                })
            });
            const tokenJson = await tokenRes.json<any>();
            const idToken = tokenJson.id_token as string | undefined;
            const email = idToken ? await verifyGoogleToken(idToken, env).catch(() => null) : null;
            if (!email) return new Response('Unauthorized', { status: 403 });
            const role = await getAccountRole(email, env);
            if (!role) return new Response('Forbidden', { status: 403 });
            const jwt = await signSession(email, env);
            const redirectTarget = new URL(returnTo);
            redirectTarget.pathname = '/';
            redirectTarget.search = '';
            redirectTarget.hash = '';
            const headers = new Headers({
                Location: redirectTarget.toString(),
                'Set-Cookie': `session=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAXAGE}`
            });
            applyNoStoreNoReferrer(headers);
            return new Response(null, {
                status: 302,
                headers
            });
        }
    }
];

// Authenticated API and asset routes
const routes: Route[] = [
    {
        method: 'GET',
        pattern: /^\/(?:|index\.html)$/,
        handler: async (request, env) => {
            const res = await env.ASSETS.fetch(request);
            const headers = new Headers(res.headers);
            applyHtmlSecurityHeaders(headers);
            return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
        }
    },
    {
        method: 'GET',
        pattern: /^\/manifest\.webmanifest$/,
        handler: (request, env) => env.ASSETS.fetch(request)
    },
    {
        method: 'GET',
        pattern: /^\/bedtime-stories-icon\.png$/,
        handler: (request, env) => env.ASSETS.fetch(request)
    },
    {
        method: 'GET',
        pattern: /^\/stories\/calendar$/,
        handler: async (_request, env, _ctx, _match, url, auth) => {
            if (auth.role !== 'editor') return new Response('Forbidden', { status: 403 });
            try {
                const startParam = url.searchParams.get('start');
                const endParam = url.searchParams.get('end');
                if (!startParam || !endParam) {
                    return new Response('Missing start or end', { status: 400 });
                }

                // Parse the incoming dates and normalize to YYYY-MM-DD
                const startDay = new Date(startParam);
                const endDay = new Date(endParam);
                if (isNaN(startDay.getTime()) || isNaN(endDay.getTime())) {
                    return new Response('Invalid date range', { status: 400 });
                }

                // Inclusive start of the first day
                const start = startDay.toISOString().slice(0, 10);
                // Exclusive end: day AFTER the requested end day
                const endExclusive = new Date(endDay);
                endExclusive.setDate(endExclusive.getDate() + 1);
                const end = endExclusive.toISOString().slice(0, 10);

                const stmt = env.DB.prepare(
                    // Keep the same SELECT alias/shape as before for compatibility
                    "SELECT substr(date,1,10) AS day, COUNT(*) AS count \
                    FROM stories \
                    WHERE date >= ?1 AND date < ?2 \
                    GROUP BY day \
                    ORDER BY day"
                ).bind(start, end);

                const { results } = await stmt.all<{ day: string; count: number }>();
                return Response.json({ days: results });
            } catch (err) {
                return new Response('Server error', { status: 500 });
            }
        }
    },
    {
        method: 'GET',
        pattern: /^\/submit(?:\.html|\/)?$/,
        handler: async (request, env, _ctx, _match, _url, auth) => {
            if (auth.role !== 'editor') return new Response('Forbidden', { status: 403 });
            const assetRequest = new Request(request.url.replace(/\/submit\/?$/, '/submit.html'), request);
            const res = await env.ASSETS.fetch(assetRequest);
            const headers = new Headers(res.headers);
            applyHtmlSecurityHeaders(headers, { cacheNoStore: true });
            return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
        }
    },
    {
        method: 'GET',
        pattern: /^\/manage(?:\.html|\/)?$/,
        handler: async (request, env, _ctx, _match, _url, auth) => {
            if (auth.role !== 'editor') return new Response('Forbidden', { status: 403 });
            const assetRequest = new Request(request.url.replace(/\/manage\/?$/, '/manage.html'), request);
            const res = await env.ASSETS.fetch(assetRequest);
            const headers = new Headers(res.headers);
            applyHtmlSecurityHeaders(headers, { cacheNoStore: true });
            return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
        }
    },
    {
        method: 'GET',
        pattern: /^\/edit(?:\.html|\/)?$/,
        handler: async (request, env, _ctx, _match, _url, auth) => {
            if (auth.role !== 'editor') return new Response('Forbidden', { status: 403 });
            const assetRequest = new Request(request.url.replace(/\/edit\/?$/, '/edit.html'), request);
            const res = await env.ASSETS.fetch(assetRequest);
            const headers = new Headers(res.headers);
            applyHtmlSecurityHeaders(headers, { cacheNoStore: true });
            return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
        }
    },
    {
        method: 'GET',
        pattern: /^\/images\/(.+)$/,
        handler: async (request, env, ctx, match) => {
            let key: string;
            try {
                key = decodeURIComponent(match[1]);
            } catch {
                return new Response('Invalid key', { status: 400 });
            }
            if (!validateMediaKey(key)) {
                return new Response('Invalid key', { status: 400 });
            }
            const { pathname, search } = new URL(request.url);
            const cacheKey = buildCacheRequest(pathname + search);
            const isRangeRequest = request.headers.has('range');
            const cache = caches.default;

            try {
                if (!isRangeRequest) {
                    const cached = await cache.match(cacheKey);
                    if (cached) return cached;
                }

                const conditionalHeaders = buildConditionalHeaders(request);
                const getOptions: R2GetOptions = {};
                if (isRangeRequest) getOptions.range = request.headers;
                if (conditionalHeaders) getOptions.onlyIf = conditionalHeaders;

                const obj = await env.IMAGES.get(key, getOptions);
                if (!obj) return new Response('Not Found', { status: 404 });

                const headers = new Headers();
                obj.writeHttpMetadata(headers);
                headers.set('etag', obj.httpEtag);
                headers.set('Cache-Control', 'public, max-age=31536000, immutable');
                headers.set('Accept-Ranges', 'bytes');
                headers.set('Content-Length', obj.size.toString());
                headers.set('X-Content-Type-Options', 'nosniff');
                headers.set('Cross-Origin-Resource-Policy', 'same-site');

                let status = 200;
                if (obj.range) {
                    const size = obj.size;
                    // Normalize range values to send back the correct content-range header
                    let start = 0;
                    let end = size - 1;
                    if ('suffix' in obj.range) {
                        const suffixLength = Math.min(obj.range.suffix, size);
                        start = Math.max(0, size - suffixLength);
                        end = size - 1;
                    } else {
                        start = obj.range.offset ?? 0;
                        const length =
                            obj.range.length !== undefined
                                ? obj.range.length
                                : size - start;
                        end = Math.min(size - 1, start + length - 1);
                    }
                    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
                    headers.set('Content-Length', (end - start + 1).toString());
                    status = 206;
                }

                const response = new Response(obj.body, { status, headers });
                if (!isRangeRequest && status === 200) {
                    ctx.waitUntil(cache.put(cacheKey, response.clone()));
                }
                return response;
            } catch {
                return new Response('Internal Error', { status: 500 });
            }
        }
    },
    {
        method: 'GET',
        pattern: /^\/stories\/list$/,
        handler: async (request, env, _ctx, _match, url, auth) => {
            if (auth.role !== 'editor') return new Response('Forbidden', { status: 403 });
            const pageParam = url.searchParams.get('page') || '1';
            const page = Number(pageParam);
            if (!Number.isInteger(page) || page < 1) {
                return new Response('Invalid page parameter', { status: 400 });
            }
            const q = url.searchParams.get('q');
            if (q && q.length > MAX_QUERY_LENGTH) {
                return new Response('Query too long', { status: 400 });
            }
            const dateStr = url.searchParams.get('date');
            let day: string | null = null;
            if (dateStr) {
                const parsed = new Date(dateStr);
                if (Number.isNaN(parsed.getTime())) {
                    return new Response('Invalid date', { status: 400 });
                }
                day = parsed.toISOString().substring(0, 10);
            }
            try {
                const limit = 10;
                const offset = (page - 1) * limit;
                let stmt: D1PreparedStatement;
                let countStmt: D1PreparedStatement;
                if (day) {
                    if (q) {
                        const like = `%${q}%`;
                        stmt = env.DB.prepare(
                            'SELECT * FROM stories WHERE substr(date,1,10) = ?1 AND (title LIKE ?2 OR content LIKE ?2) ORDER BY date DESC, id DESC LIMIT ?3 OFFSET ?4'
                        ).bind(day, like, limit, offset);
                        countStmt = env.DB.prepare(
                            'SELECT COUNT(*) as count FROM stories WHERE substr(date,1,10) = ?1 AND (title LIKE ?2 OR content LIKE ?2)'
                        ).bind(day, like);
                    } else {
                        stmt = env.DB.prepare(
                            'SELECT * FROM stories WHERE substr(date,1,10) = ?1 ORDER BY date DESC, id DESC LIMIT ?2 OFFSET ?3'
                        ).bind(day, limit, offset);
                        countStmt = env.DB.prepare(
                            'SELECT COUNT(*) as count FROM stories WHERE substr(date,1,10) = ?1'
                        ).bind(day);
                    }
                } else if (q) {
                    const like = `%${q}%`;
                    stmt = env.DB.prepare(
                        'SELECT * FROM stories WHERE title LIKE ?1 OR content LIKE ?1 ORDER BY date DESC, id DESC LIMIT ?2 OFFSET ?3'
                    ).bind(like, limit, offset);
                    countStmt = env.DB.prepare(
                        'SELECT COUNT(*) as count FROM stories WHERE title LIKE ?1 OR content LIKE ?1'
                    ).bind(like);
                } else {
                    stmt = env.DB.prepare(
                        'SELECT * FROM stories ORDER BY date DESC, id DESC LIMIT ?1 OFFSET ?2'
                    ).bind(limit, offset);
                    countStmt = env.DB.prepare('SELECT COUNT(*) as count FROM stories');
                }
                const { results } = await stmt.all<Story>();
                const count = (await countStmt.first<{ count: number }>())?.count || 0;
                return Response.json({ stories: results, total: count });
            } catch {
                return new Response('Internal Error', { status: 500 });
            }
        }
    },
    {
        method: 'GET',
        pattern: /^\/stories$/,
        handler: async (_request, env) => {
            try {
                const nowIso = easternNowIso();
                const stmt = env.DB.prepare(
                    'SELECT * FROM stories WHERE date <= ?1 ORDER BY date DESC, id DESC LIMIT 1'
                ).bind(nowIso);
                const story = await stmt.first<Story>();
                if (!story) {
                    return new Response('Not Found', { status: 404 });
                }
                return Response.json(withContentText(story));
            } catch {
                return new Response('Internal Error', { status: 500 });
            }
        }
    },
    {
        method: 'GET',
        pattern: /^\/stories\/(\d+)(?:\/(next|prev))?$/,
        handler: async (_request, env, _ctx, match) => {
            const id = Number(match[1]);
            if (!Number.isInteger(id)) {
                return new Response('Invalid story id', { status: 400 });
            }

            if (match[2]) {
                try {
                    const order = match[2] === 'next' ? 'DESC' : 'ASC';
                    const cmp = match[2] === 'next' ? '<' : '>';
                    const nowIso = easternNowIso();
                    const stmt = env.DB.prepare(
                        `SELECT * FROM stories WHERE date <= ?1 AND (` +
                        `date ${cmp} (SELECT date FROM stories WHERE id = ?2)` +
                        ` OR (date = (SELECT date FROM stories WHERE id = ?2) AND id ${cmp} ?2)) ` +
                        `ORDER BY date ${order}, id ${order} LIMIT 1`
                    ).bind(nowIso, id);
                    const story = await stmt.first<Story>();
                    if (!story) {
                        return new Response('Not Found', { status: 404 });
                    }
                    return Response.json(withContentText(story));
                } catch {
                    return new Response('Internal Error', { status: 500 });
                }
            }

            try {
                const stmt = env.DB.prepare('SELECT * FROM stories WHERE id = ?1').bind(id);
                const story = await stmt.first<Story>();
                if (!story) {
                    return new Response('Not Found', { status: 404 });
                }
                return Response.json(withContentText(story));
            } catch {
                return new Response('Internal Error', { status: 500 });
            }
        }
    },
    {
        method: 'POST',
        pattern: /^\/stories$/,
        handler: async (request, env, _ctx, _match, _url, auth) => {
            if (auth.role !== 'editor') return new Response('Forbidden', { status: 403 });
            if (!request.headers.get('content-type')?.includes('multipart/form-data')) {
                return new Response('Expected multipart/form-data', { status: 400 });
            }
            const data = await request.formData();
            const title = data.get('title');
            const contentMd = data.get('content');
            const dateStr = data.get('date');
            const imageFile = data.get('image');
            const videoFile = data.get('video');            
            if (typeof title !== 'string' || typeof contentMd !== 'string') {
                return new Response('Invalid form data', { status: 400 });
            }
            const trimmedTitle = title.trim();
            const trimmedContent = contentMd.trim();
            if (!trimmedTitle || !trimmedContent) {
                return new Response('Missing title or content', { status: 400 });
            }
            if (trimmedTitle.length > MAX_TITLE_LENGTH) {
                return new Response('Title too long', { status: 400 });
            }
            if (trimmedContent.length > MAX_CONTENT_LENGTH) {
                return new Response('Content too long', { status: 400 });
            }
            let dateIso = new Date().toISOString();
            if (typeof dateStr === 'string' && dateStr.trim()) {
                const parsed = new Date(dateStr);
                if (Number.isNaN(parsed.getTime())) {
                    return new Response('Invalid date', { status: 400 });
                }
                dateIso = parsed.toISOString();
            }
            const contentHtml = markdownToHtml(trimmedContent);
            let imageKey: string | null = null;
            let videoKey: string | null = null;
            if (imageFile instanceof File) {
                const uploadError = validateUpload(imageFile, 'image');
                if (uploadError) return uploadError;
                imageKey = crypto.randomUUID() + getContentTypeExtension(imageFile.type);
                await env.IMAGES.put(imageKey, imageFile.stream(), { httpMetadata: { contentType: imageFile.type } });
            }
            if (videoFile instanceof File) {
                const uploadError = validateUpload(videoFile, 'video');
                if (uploadError) return uploadError;
                videoKey = crypto.randomUUID() + getContentTypeExtension(videoFile.type);
                await env.IMAGES.put(videoKey, videoFile.stream(), { httpMetadata: { contentType: videoFile.type } });
            }
            try {
                const stmt = env.DB.prepare(
                    'INSERT INTO stories (title, content, date, image_url, video_url, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, datetime(\'now\'), datetime(\'now\'))'
                ).bind(trimmedTitle, contentHtml, dateIso, imageKey, videoKey);
                const result = await stmt.run();
                const id = result.meta.last_row_id;
                return Response.json({ id });
            } catch {
                return new Response('Internal Error', { status: 500 });
            }
        }
    },
    {
        method: 'PUT',
        pattern: /^\/stories\/(\d+)$/,
        handler: async (request, env, _ctx, match, _url, auth) => {
            if (auth.role !== 'editor') return new Response('Forbidden', { status: 403 });
            const id = Number(match[1]);
            if (!Number.isInteger(id)) {
                return new Response('Invalid story id', { status: 400 });
            }
            if (!request.headers.get('content-type')?.includes('multipart/form-data')) {
                return new Response('Expected multipart/form-data', { status: 400 });
            }
            const data = await request.formData();
            const title = data.get('title');
            const contentMd = data.get('content');
            const dateStr = data.get('date');
            const imageFile = data.get('image');
            const videoFile = data.get('video');
            if (typeof title !== 'string' || typeof contentMd !== 'string') {
                return new Response('Invalid form data', { status: 400 });
            }
            const trimmedTitle = title.trim();
            const trimmedContent = contentMd.trim();
            if (!trimmedTitle || !trimmedContent) {
                return new Response('Missing title or content', { status: 400 });
            }
            if (trimmedTitle.length > MAX_TITLE_LENGTH) {
                return new Response('Title too long', { status: 400 });
            }
            if (trimmedContent.length > MAX_CONTENT_LENGTH) {
                return new Response('Content too long', { status: 400 });
            }
            let dateIso = new Date().toISOString();
            if (typeof dateStr === 'string' && dateStr.trim()) {
                const parsed = new Date(dateStr);
                if (Number.isNaN(parsed.getTime())) {
                    return new Response('Invalid date', { status: 400 });
                }
                dateIso = parsed.toISOString();
            }
            const contentHtml = markdownToHtml(trimmedContent);
            let imageKey: string | undefined;
            let videoKey: string | undefined;
            try {
                const old = await env.DB.prepare('SELECT image_url, video_url FROM stories WHERE id = ?1').bind(id).first<{ image_url: string | null; video_url: string | null }>();
                if (imageFile instanceof File) {
                    const uploadError = validateUpload(imageFile, 'image');
                    if (uploadError) return uploadError;
                    imageKey = crypto.randomUUID() + getContentTypeExtension(imageFile.type);
                    await env.IMAGES.put(imageKey, imageFile.stream(), { httpMetadata: { contentType: imageFile.type } });
                    if (old?.image_url) await env.IMAGES.delete(old.image_url);
                }
                if (videoFile instanceof File) {
                    const uploadError = validateUpload(videoFile, 'video');
                    if (uploadError) return uploadError;
                    videoKey = crypto.randomUUID() + getContentTypeExtension(videoFile.type);
                    await env.IMAGES.put(videoKey, videoFile.stream(), { httpMetadata: { contentType: videoFile.type } });
                    if (old?.video_url) await env.IMAGES.delete(old.video_url);
                }
                const stmt = env.DB.prepare(
                    'UPDATE stories SET title = ?1, content = ?2, date = ?3, updated = datetime(\'now\')' +
                    (imageKey !== undefined ? ', image_url = ?4' : '') +
                    (videoKey !== undefined ? (imageKey !== undefined ? ', video_url = ?5' : ', video_url = ?4') : '') +
                    ' WHERE id = ?' + (imageKey !== undefined || videoKey !== undefined ? (imageKey !== undefined && videoKey !== undefined ? '6' : '5') : '4')
                );
                const params: (string | number)[] = [trimmedTitle, contentHtml, dateIso];
                if (imageKey !== undefined) params.push(imageKey);
                if (videoKey !== undefined) params.push(videoKey);
                params.push(id);
                await stmt.bind(...params).run();
                return new Response('OK');
            } catch {
                return new Response('Internal Error', { status: 500 });
            }
        }
    },
    {
        method: 'DELETE',
        pattern: /^\/stories\/(\d+)$/,
        handler: async (_request, env, _ctx, match, _url, auth) => {
            if (auth.role !== 'editor') return new Response('Forbidden', { status: 403 });
            const id = Number(match[1]);
            if (!Number.isInteger(id)) {
                return new Response('Invalid story id', { status: 400 });
            }
            try {
                const story = await env.DB.prepare('SELECT image_url, video_url FROM stories WHERE id = ?1').bind(id).first<{ image_url: string | null; video_url: string | null }>();
                await env.DB.prepare('DELETE FROM stories WHERE id = ?1').bind(id).run();
                if (story?.image_url) await env.IMAGES.delete(story.image_url);
                if (story?.video_url) await env.IMAGES.delete(story.video_url);
                return new Response('OK');
            } catch {
                return new Response('Internal Error', { status: 500 });
            }
        }
    }
];

export async function fetchHandler(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    for (const route of preAuthRoutes) {
        if (request.method === route.method && route.pattern.test(url.pathname)) {
            const match = url.pathname.match(route.pattern)!;
            return await route.handler(request, env, ctx, match, url, { email: '', role: 'reader' });
        }
    }

    const auth = await requireAuth(request, env);
    if (auth instanceof Response) return auth;

    for (const route of routes) {
        if (request.method === route.method && route.pattern.test(url.pathname)) {
            const match = url.pathname.match(route.pattern)!;
            return await route.handler(request, env, ctx, match, url, auth);
        }
    }

    return new Response('Not Found', { status: 404 });
}
