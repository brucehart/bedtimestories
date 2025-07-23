import { Env } from './types';

const SESSION_DAYS = 180;
export const SESSION_MAXAGE = 60 * 60 * 24 * SESSION_DAYS;

let ENC_KEY_PROMISE: Promise<CryptoKey> | null = null;
function getEncKey(env: Env): Promise<CryptoKey> {
    if (!ENC_KEY_PROMISE) {
        ENC_KEY_PROMISE = crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(env.SESSION_HMAC_KEY),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign', 'verify']
        );
    }
    return ENC_KEY_PROMISE;
}

export async function signSession(email: string, env: Env) {
    const header = btoa('{"alg":"HS256","typ":"JWT"}')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    const now = Math.floor(Date.now() / 1000);
    const payload = btoa(
        JSON.stringify({ email, iat: now, exp: now + SESSION_MAXAGE })
    )
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    const data = new TextEncoder().encode(`${header}.${payload}`);
    const sig = await crypto.subtle.sign('HMAC', await getEncKey(env), data);
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    return `${header}.${payload}.${sigB64}`;
}

export async function verifySession(jwt: string, env: Env): Promise<string | null> {
    const [h, p, s] = jwt.split('.');
    if (!h || !p || !s) return null;
    const data = new TextEncoder().encode(`${h}.${p}`);
    const sig = Uint8Array.from(
        atob(s.replace(/-/g, '+').replace(/_/g, '/')),
        c => c.charCodeAt(0)
    );
    const ok = await crypto.subtle.verify(
        'HMAC',
        await getEncKey(env),
        sig,
        data
    );
    if (!ok) return null;
    const { email, exp } = JSON.parse(
        atob(p.replace(/-/g, '+').replace(/_/g, '/'))
    );
    return Date.now() / 1000 < exp ? email : null;
}

const STATE_MAXAGE = 300;

export async function signState(returnTo: string, env: Env) {
    const header = btoa('{"alg":"HS256","typ":"JWT"}')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    const now = Math.floor(Date.now() / 1000);
    const payload = btoa(
        JSON.stringify({ return_to: returnTo, iat: now, exp: now + STATE_MAXAGE })
    )
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    const data = new TextEncoder().encode(`${header}.${payload}`);
    const sig = await crypto.subtle.sign('HMAC', await getEncKey(env), data);
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    return `${header}.${payload}.${sigB64}`;
}

export async function verifyState(token: string, env: Env): Promise<string | null> {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;
    const data = new TextEncoder().encode(`${h}.${p}`);
    const sig = Uint8Array.from(
        atob(s.replace(/-/g, '+').replace(/_/g, '/')),
        c => c.charCodeAt(0)
    );
    const ok = await crypto.subtle.verify(
        'HMAC',
        await getEncKey(env),
        sig,
        data
    );
    if (!ok) return null;
    const { return_to, exp } = JSON.parse(
        atob(p.replace(/-/g, '+').replace(/_/g, '/'))
    );
    return Date.now() / 1000 < exp ? (return_to as string) : null;
}
