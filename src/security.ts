const encoder = new TextEncoder();

export function timingSafeEqualString(provided: string, expected: string): boolean {
    const expectedBytes = encoder.encode(expected);
    const providedBytes = encoder.encode(provided);
    if (expectedBytes.length === 0) return false;

    if (providedBytes.length !== expectedBytes.length) {
        const padded = new Uint8Array(expectedBytes.length);
        padded.set(providedBytes.slice(0, expectedBytes.length));
        crypto.subtle.timingSafeEqual(padded, expectedBytes);
        return false;
    }

    return crypto.subtle.timingSafeEqual(providedBytes, expectedBytes);
}

export function bearerToken(request: Request): string | null {
    const header = request.headers.get('Authorization') || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
}

export async function sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
    return [...new Uint8Array(digest)]
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

export function randomToken(bytes = 32): string {
    const data = new Uint8Array(bytes);
    crypto.getRandomValues(data);
    let raw = '';
    for (const byte of data) raw += String.fromCharCode(byte);
    return btoa(raw).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
