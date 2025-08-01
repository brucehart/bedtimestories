import { AuthInfo, Env, Route, Story } from './types';
import { markdownToHtml, easternNowIso } from './utils';
import { signSession, signState, verifyState, verifySession, SESSION_MAXAGE } from './session';
import { verifyGoogleToken, getAccountRole, requireAuth } from './auth';

// Routes for login flow and OAuth callback
const preAuthRoutes: Route[] = [
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
        handler: async (_request, env, _ctx, match) => {
            const key = decodeURIComponent(match[1]);
            try {
                const obj = await env.IMAGES.get(key);
                if (!obj) return new Response('Not Found', { status: 404 });
                const headers = new Headers();
                obj.writeHttpMetadata(headers);
                headers.set('etag', obj.httpEtag);
                headers.set('Cache-Control', 'public, max-age=31536000, immutable');
                return new Response(obj.body, { headers });
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
