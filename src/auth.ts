import { Env, AuthInfo } from './types';
import { parseCookies } from './utils';
import { signSession, verifySession, SESSION_MAXAGE } from './session';

// Validate the ID token from Google OAuth and return the user email
export async function verifyGoogleToken(token: string, env: Env): Promise<string | null> {
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

// Retrieve the role for the given account or null if not allowed. If the
// `allowed_accounts` table is empty any account is treated as an editor.
export async function getAccountRole(
    email: string,
    env: Env
): Promise<'editor' | 'reader' | null> {
    try {
        const row = await env.DB
            .prepare(
                'SELECT role FROM allowed_accounts WHERE LOWER(email) = LOWER(?1) LIMIT 1'
            )
            .bind(email)
            .first<{ role: string }>();
        if (row) return row.role === 'reader' ? 'reader' : 'editor';
        const count = await env.DB
            .prepare('SELECT COUNT(*) as count FROM allowed_accounts')
            .first<{ count: number }>();
        return count && count.count === 0 ? 'editor' : null;
    } catch {
        return null;
    }
}

// Guard that redirects to /login unless the user has a valid session
export async function requireAuth(request: Request, env: Env): Promise<Response | AuthInfo> {
    const url = new URL(request.url);
    const isPublicRoute =
        env.PUBLIC_VIEW === 'true' &&
        request.method === 'GET' &&
        (
            url.pathname === '/' ||
            url.pathname === '/index.html' ||
            url.pathname === '/stories' ||
            /^\/stories\/\d+(?:\/(next|prev))?$/.test(url.pathname) ||
            url.pathname.startsWith('/images/')
        );

    const cookies = parseCookies(request.headers.get('Cookie'));
    const token = cookies['session'];

    if (!token && isPublicRoute) {
        return { email: '', role: 'reader' };
    }

    let email = token ? await verifySession(token, env) : null;
    if (!email && token) {
        email = await verifyGoogleToken(token, env).catch(() => null);
        if (email) {
            const jwt = await signSession(email, env);
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
        if (isPublicRoute) return { email: '', role: 'reader' };
        return new Response(null, { status: 302, headers: { Location: '/login' } });
    }
    const role = await getAccountRole(email, env);
    if (!role) {
        return new Response('Forbidden', { status: 403 });
    }
    return { email, role };
}
