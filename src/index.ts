
// Cloudflare Worker used to store and manage short bedtime stories.

// Data stored for each story record
interface Story {
    id: number;
    title: string;
    content: string;
    date: string;
    image_url: string | null;
    created: string | null;
    updated: string | null;
}

// Bindings provided by wrangler configuration
interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    IMAGES: R2Bucket;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    ALLOWED_ACCOUNTS: string; 
    SESSION_HMAC_KEY: string;  
}

const SESSION_DAYS = 180;
const SESSION_MAXAGE = 60 * 60 * 24 * SESSION_DAYS;
const SESSION_HMAC_KEY = "IcsZsMeT7t4VomO9lBJ/g1EsDqEkJuyVSjHQwQRUCj4=";

const ENC_KEY = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SESSION_HMAC_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
);
async function signSession(email: string) {
    const header = btoa('{"alg":"HS256","typ":"JWT"}')
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    const now = Math.floor(Date.now() / 1000);
    const payload = btoa(
        JSON.stringify({ email, iat: now, exp: now + SESSION_MAXAGE })
    )
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    const data = new TextEncoder().encode(`${header}.${payload}`);
    const sig = await crypto.subtle.sign("HMAC", await ENC_KEY, data);
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    return `${header}.${payload}.${sigB64}`;
}
async function verifySession(jwt: string): Promise<string | null> {
    const [h, p, s] = jwt.split('.');
    if (!h || !p || !s) return null;
    const data = new TextEncoder().encode(`${h}.${p}`);
    const sig = Uint8Array.from(
        atob(s.replace(/-/g, "+").replace(/_/g, "/")),
        c => c.charCodeAt(0)
    );
    const ok = await crypto.subtle.verify(
        "HMAC",
        await ENC_KEY,
        sig,
        data
    );
    if (!ok) return null;
    const { email, exp } = JSON.parse(
        atob(p.replace(/-/g, "+").replace(/_/g, "/"))
    );
    return Date.now() / 1000 < exp ? email : null;
}

// Escape HTML special characters
function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[c] as string));
}

// Convert very small subset of markdown to HTML
function markdownToHtml(md: string): string {
    return md
        .split(/\n\n+/)
        .map(block => {
            const line = block.trim();
            if (line.startsWith('### ')) return `<h3>${escapeHtml(line.slice(4))}</h3>`;
            if (line.startsWith('## ')) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
            if (line.startsWith('# ')) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
            const html = escapeHtml(line)
                .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                .replace(/\*(.+?)\*/g, '<em>$1</em>')
                .replace(/\n/g, '<br/>');
            return `<p>${html}</p>`;
        })
        .join('');
}

// Parse cookies from a request header
function parseCookies(cookieHeader: string | null): Record<string, string> {
    const cookies: Record<string, string> = {};
    if (!cookieHeader) return cookies;
    for (const pair of cookieHeader.split(';')) {
        const [key, ...vals] = pair.trim().split('=');
        cookies[key] = vals.join('=');
    }
    return cookies;
}

// Validate the ID token from Google OAuth and return the user email
async function verifyGoogleToken(token: string, env: Env): Promise<string | null> {
    if (env.GOOGLE_CLIENT_ID === 'test' && token === 'test-token') {
        return 'test@example.com';
    }
    const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
    if (!resp.ok) return null;
    const data = await resp.json<any>();
    if (data.aud !== env.GOOGLE_CLIENT_ID) return null;
    if (Date.now() / 1000 > Number(data.exp)) return null;
    return data.email as string;
}

// Guard that redirects to /login unless the user has a valid session
async function requireAuth(request: Request, env: Env): Promise<Response | { email: string }> {
    const cookies = parseCookies(request.headers.get('Cookie'));
    const token = cookies['session'];
    if (!token) {
        return new Response(null, { status: 302, headers: { Location: '/login' } });
    }
    const url = new URL(request.url);
    let email = await verifySession(token);
    if (!email) {
        email = await verifyGoogleToken(token, env).catch(() => null);
        if (email) {
            const jwt = await signSession(email);
            return new Response(null, {
                status: 302,
                headers: {
                    Location: url.pathname + url.search,
                    'Set-Cookie': `session=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAXAGE}`
                }
            });
        }
    }
    if (!email) {
        return new Response(null, { status: 302, headers: { Location: '/login' } });
    }
    const allowed = env.ALLOWED_ACCOUNTS.split(',').map(a => a.trim()).filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(email)) {
        return new Response('Forbidden', { status: 403 });
    }
    return { email };
}

// Simple route descriptor used by the router below
interface Route {
    method: string;
    pattern: RegExp;
    handler: (req: Request, env: Env, ctx: ExecutionContext, match: RegExpMatchArray, url: URL) => Promise<Response> | Response;
}

// Routes for login flow and OAuth callback
const preAuthRoutes: Route[] = [
    {
        method: 'GET',
        pattern: /^\/login$/,
        handler: (request, env, _ctx, _match, url) => {
            const redirectUri = url.origin + '/oauth/callback';
            const params = new URLSearchParams({
                client_id: env.GOOGLE_CLIENT_ID,
                redirect_uri: redirectUri,
                response_type: 'code',
                scope: 'openid email',
                prompt: 'select_account'
            });
            return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString(), 302);
        }
    },
    {
        method: 'GET',
        pattern: /^\/oauth\/callback$/,
        handler: async (request, env, _ctx, _match, url) => {
            const code = url.searchParams.get('code');
            if (!code) return new Response('Missing code', { status: 400 });
            const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                body: new URLSearchParams({
                    code,
                    client_id: env.GOOGLE_CLIENT_ID,
                    client_secret: env.GOOGLE_CLIENT_SECRET,
                    redirect_uri: url.origin + '/oauth/callback',
                    grant_type: 'authorization_code'
                })
            });
            const tokenJson = await tokenRes.json<any>();
            const idToken = tokenJson.id_token as string | undefined;
            const email = idToken ? await verifyGoogleToken(idToken, env).catch(() => null) : null;
            if (!email) return new Response('Unauthorized', { status: 403 });
            const allowed = env.ALLOWED_ACCOUNTS.split(',').map(a => a.trim()).filter(Boolean);
            if (allowed.length > 0 && !allowed.includes(email)) return new Response('Forbidden', { status: 403 });
            const jwt = await signSession(email);
            return new Response(null, {
                status: 302,
                headers: {
                    Location: '/',
                    'Set-Cookie': `session=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAXAGE}`
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
        pattern: /^\/submit(?:\.html|\/)?$/,
        handler: async (request, env) => {
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
        handler: (request, env) => {
            const assetRequest = new Request(request.url.replace(/\/manage\/?$/, '/manage.html'), request);
            return env.ASSETS.fetch(assetRequest);
        }
    },
    {
        method: 'GET',
        pattern: /^\/edit(?:\.html|\/)?$/,
        handler: async (request, env) => {
            const assetRequest = new Request(request.url.replace(/\/edit\/?$/, '/edit.html'), request);
            const res = await env.ASSETS.fetch(assetRequest);
            const headers = new Headers(res.headers);
            headers.set('Cache-Control', 'no-store');
            return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
        }
    },
    {
        method: 'GET',
        pattern: /^\/stories\/list$/,
        handler: async (request, env, _ctx, _match, url) => {
            try {
                const page = Number(url.searchParams.get('page') || '1');
                const q = url.searchParams.get('q');
                const limit = 10;
                const offset = (page - 1) * limit;
                let stmt: D1PreparedStatement;
                let countStmt: D1PreparedStatement;
                if (q) {
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
                const stmt = env.DB.prepare('SELECT * FROM stories ORDER BY date DESC, id DESC LIMIT 1');
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
                    const stmt = env.DB.prepare(
                        `SELECT * FROM stories WHERE (date ${cmp} (SELECT date FROM stories WHERE id = ?1)` +
                        ` OR (date = (SELECT date FROM stories WHERE id = ?1) AND id ${cmp} ?1)) ` +
                        `ORDER BY date ${order}, id ${order} LIMIT 1`
                    ).bind(id);
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
        handler: async (request, env) => {
            if (!request.headers.get('content-type')?.includes('multipart/form-data')) {
                return new Response('Expected multipart/form-data', { status: 400 });
            }
            const data = await request.formData();
            const title = data.get('title');
            const contentMd = data.get('content');
            const dateStr = data.get('date');
            const imageFile = data.get('image');
            if (typeof title !== 'string' || typeof contentMd !== 'string') {
                return new Response('Invalid form data', { status: 400 });
            }
            const contentHtml = markdownToHtml(contentMd);
            let imageKey: string | null = null;
            if (imageFile instanceof File) {
                const arrayBuffer = await imageFile.arrayBuffer();
                const parts = imageFile.name.split('.');
                const ext = parts.length > 1 ? '.' + parts.pop() : '';
                imageKey = crypto.randomUUID() + ext;
                await env.IMAGES.put(imageKey, arrayBuffer);
            }
            try {
                const stmt = env.DB.prepare(
                    'INSERT INTO stories (title, content, date, image_url, created, updated) VALUES (?1, ?2, ?3, ?4, datetime(\'now\'), datetime(\'now\'))'
                ).bind(title, contentHtml, typeof dateStr === 'string' && dateStr ? new Date(dateStr).toISOString() : new Date().toISOString(), imageKey);
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
        handler: async (request, env, _ctx, match) => {
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
            if (typeof title !== 'string' || typeof contentMd !== 'string') {
                return new Response('Invalid form data', { status: 400 });
            }
            const contentHtml = markdownToHtml(contentMd);
            let imageKey: string | undefined;
            try {
                const old = await env.DB.prepare('SELECT image_url FROM stories WHERE id = ?1').bind(id).first<{ image_url: string | null }>();
                if (imageFile instanceof File) {
                    const arrayBuffer = await imageFile.arrayBuffer();
                    const parts = imageFile.name.split('.');
                    const ext = parts.length > 1 ? '.' + parts.pop() : '';
                    imageKey = crypto.randomUUID() + ext;
                    await env.IMAGES.put(imageKey, arrayBuffer);
                    if (old?.image_url) await env.IMAGES.delete(old.image_url);
                }
                const stmt = env.DB.prepare(
                    'UPDATE stories SET title = ?1, content = ?2, date = ?3, updated = datetime(\'now\')' + (imageKey !== undefined ? ', image_url = ?4' : '') + ' WHERE id = ?' + (imageKey !== undefined ? '5' : '4')
                );
                const dateIso = typeof dateStr === 'string' && dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();
                if (imageKey !== undefined) {
                    await stmt.bind(title, contentHtml, dateIso, imageKey, id).run();
                } else {
                    await stmt.bind(title, contentHtml, dateIso, id).run();
                }
                return new Response('OK');
            } catch {
                return new Response('Internal Error', { status: 500 });
            }
        }
    },
    {
        method: 'DELETE',
        pattern: /^\/stories\/(\d+)$/,
        handler: async (_request, env, _ctx, match) => {
            const id = Number(match[1]);
            if (!Number.isInteger(id)) {
                return new Response('Invalid story id', { status: 400 });
            }
            try {
                const story = await env.DB.prepare('SELECT image_url FROM stories WHERE id = ?1').bind(id).first<{ image_url: string | null }>();
                await env.DB.prepare('DELETE FROM stories WHERE id = ?1').bind(id).run();
                if (story?.image_url) await env.IMAGES.delete(story.image_url);
                return new Response('OK');
            } catch {
                return new Response('Internal Error', { status: 500 });
            }
        }
    }
];

// Entry point that dispatches requests to the route handlers
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        for (const route of preAuthRoutes) {
            if (request.method === route.method && route.pattern.test(url.pathname)) {
                const match = url.pathname.match(route.pattern)!;
                return await route.handler(request, env, ctx, match, url);
            }
        }

        const auth = await requireAuth(request, env);
        if (auth instanceof Response) return auth;

        for (const route of routes) {
            if (request.method === route.method && route.pattern.test(url.pathname)) {
                const match = url.pathname.match(route.pattern)!;
                return await route.handler(request, env, ctx, match, url);
            }
        }

        return new Response('Not Found', { status: 404 });
    },
} satisfies ExportedHandler<Env>;

export { signSession, verifySession, SESSION_MAXAGE };
