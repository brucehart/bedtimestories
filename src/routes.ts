import { AuthInfo, Env, Route, Story } from './types';
import { markdownToHtml, easternNowIso } from './utils';
import { signSession, signState, verifyState, verifySession, SESSION_MAXAGE } from './session';
import { verifyGoogleToken, getAccountRole, requireAuth } from './auth';

const CACHE_REFRESH_DEFAULT_DAYS = 5;
const CACHE_REFRESH_MAX_DAYS = 30;

const CACHE_KEY_PREFIX = 'https://bedtimestories.bruce-hart.workers.dev';

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
    for (const name of conditionalNames) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
    }
    return headers.size > 0 ? headers : undefined;
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
            if (requiredToken) {
                const authHeader = request.headers.get('Authorization');
                if (authHeader !== `Bearer ${requiredToken}`) {
                    return new Response('Forbidden', { status: 403 });
                }
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
            return Response.redirect(
                'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString(),
                302
            );
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
                return new Response(null, {
                    status: 302,
                    headers: {
                        Location: '/',
                        'Set-Cookie': `session=${tokenParam}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAXAGE}`
                    }
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
            return new Response(null, {
                status: 302,
                headers: {
                    Location: `${returnTo}/oauth/callback?token=${encodeURIComponent(jwt)}`
                }
            });
        }
    }
];

// Authenticated API and asset routes
const routes: Route[] = [
    {
        method: 'GET',
        pattern: /^\/(?:|index\.html)$/,
        handler: (request, env) => env.ASSETS.fetch(request)
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
            headers.set('Cache-Control', 'no-store');
            return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
        }
    },
    {
        method: 'GET',
        pattern: /^\/manage(?:\.html|\/)?$/,
        handler: (request, env, _ctx, _match, _url, auth) => {
            if (auth.role !== 'editor') return new Response('Forbidden', { status: 403 });
            const assetRequest = new Request(request.url.replace(/\/manage\/?$/, '/manage.html'), request);
            return env.ASSETS.fetch(assetRequest);
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
            headers.set('Cache-Control', 'no-store');
            return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
        }
    },
    {
        method: 'GET',
        pattern: /^\/images\/(.+)$/,
        handler: async (request, env, ctx, match) => {
            const key = decodeURIComponent(match[1]);
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
            try {
                const page = Number(url.searchParams.get('page') || '1');
                const q = url.searchParams.get('q');
                const dateStr = url.searchParams.get('date');
                const limit = 10;
                const offset = (page - 1) * limit;
                let stmt: D1PreparedStatement;
                let countStmt: D1PreparedStatement;
                if (dateStr) {
                    const day = new Date(dateStr).toISOString().substring(0, 10);
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
                return Response.json(story);
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
                    return Response.json(story);
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
                return Response.json(story);
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
            const contentHtml = markdownToHtml(contentMd);
            let imageKey: string | null = null;
            let videoKey: string | null = null;
            if (imageFile instanceof File) {
                const arrayBuffer = await imageFile.arrayBuffer();
                const parts = imageFile.name.split('.');
                const ext = parts.length > 1 ? '.' + parts.pop() : '';
                imageKey = crypto.randomUUID() + ext;
                await env.IMAGES.put(imageKey, arrayBuffer);
            }
            if (videoFile instanceof File) {
                const arrayBuffer = await videoFile.arrayBuffer();
                const parts = videoFile.name.split('.');
                const ext = parts.length > 1 ? '.' + parts.pop() : '';
                videoKey = crypto.randomUUID() + ext;
                await env.IMAGES.put(videoKey, arrayBuffer);
            }
            try {
                const stmt = env.DB.prepare(
                    'INSERT INTO stories (title, content, date, image_url, video_url, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, datetime(\'now\'), datetime(\'now\'))'
                ).bind(title, contentHtml, typeof dateStr === 'string' && dateStr ? new Date(dateStr).toISOString() : new Date().toISOString(), imageKey, videoKey);
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
            const contentHtml = markdownToHtml(contentMd);
            let imageKey: string | undefined;
            let videoKey: string | undefined;
            try {
                const old = await env.DB.prepare('SELECT image_url, video_url FROM stories WHERE id = ?1').bind(id).first<{ image_url: string | null; video_url: string | null }>();
                if (imageFile instanceof File) {
                    const arrayBuffer = await imageFile.arrayBuffer();
                    const parts = imageFile.name.split('.');
                    const ext = parts.length > 1 ? '.' + parts.pop() : '';
                    imageKey = crypto.randomUUID() + ext;
                    await env.IMAGES.put(imageKey, arrayBuffer);
                    if (old?.image_url) await env.IMAGES.delete(old.image_url);
                }
                if (videoFile instanceof File) {
                    const arrayBuffer = await videoFile.arrayBuffer();
                    const parts = videoFile.name.split('.');
                    const ext = parts.length > 1 ? '.' + parts.pop() : '';
                    videoKey = crypto.randomUUID() + ext;
                    await env.IMAGES.put(videoKey, arrayBuffer);
                    if (old?.video_url) await env.IMAGES.delete(old.video_url);
                }
                const stmt = env.DB.prepare(
                    'UPDATE stories SET title = ?1, content = ?2, date = ?3, updated = datetime(\'now\')' +
                    (imageKey !== undefined ? ', image_url = ?4' : '') +
                    (videoKey !== undefined ? (imageKey !== undefined ? ', video_url = ?5' : ', video_url = ?4') : '') +
                    ' WHERE id = ?' + (imageKey !== undefined || videoKey !== undefined ? (imageKey !== undefined && videoKey !== undefined ? '6' : '5') : '4')
                );
                const dateIso = typeof dateStr === 'string' && dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();
                const params: (string | number)[] = [title, contentHtml, dateIso];
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
