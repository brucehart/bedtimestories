import { Env, AuthInfo } from './types';
import { parseCookies } from './utils';
import { signSession, verifySession, SESSION_MAXAGE } from './session';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const GOOGLE_JWKS = createRemoteJWKSet(
    new URL('https://www.googleapis.com/oauth2/v3/certs'),
    {
        cacheMaxAge: 10 * 60 * 1000,
        cooldownDuration: 30 * 1000,
        timeoutDuration: 5 * 1000
    }
);
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const MAX_EMAIL_LENGTH = 320;

// Validate the ID token from Google OAuth and return the user email
export async function verifyGoogleToken(token: string, env: Env): Promise<string | null> {
    if (!token || !env.GOOGLE_CLIENT_ID) return null;
    try {
        const { payload } = await jwtVerify(token, GOOGLE_JWKS, {
            algorithms: ['RS256'],
            audience: env.GOOGLE_CLIENT_ID,
            issuer: GOOGLE_ISSUERS
        });
        const email = typeof payload.email === 'string' ? payload.email.trim() : '';
        if (!payload.sub || payload.email_verified !== true) return null;
        if (!email || email.length > MAX_EMAIL_LENGTH || !email.includes('@')) return null;
        return email;
    } catch {
        return null;
    }
}

// Retrieve only explicitly recognized roles for explicitly allowlisted accounts.
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
        if (!row) return null;
        if (row.role === 'reader' || row.role === 'editor') return row.role;
        return null;
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
            url.pathname === '/manifest.webmanifest' ||
            url.pathname === '/bedtime-stories-icon.png' ||
            url.pathname === '/stories' ||
            /^\/stories\/\d+(?:\/(next|prev))?$/.test(url.pathname) ||
            /^\/(?:assets|vendor)\/[A-Za-z0-9._-]+\.js$/.test(url.pathname) ||
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
