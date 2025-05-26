import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker, { signSession, verifySession, SESSION_MAXAGE } from '../src/index';

function createAllowedDb(emails: string[]) {
    return {
        prepare(query: string) {
            return {
                bind(email?: string) {
                    return {
                        async first<T>() {
                            if (query.includes('COUNT(*)')) {
                                return { count: emails.length } as T;
                            }
                            return emails.includes(email as string) ? ({} as T) : null;
                        }
                    };
                }
            };
        }
    } as unknown as D1Database;
}

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Story page', () => {
        env.GOOGLE_CLIENT_ID = 'test';
        env.GOOGLE_CLIENT_SECRET = 'test';
        env.DB = createAllowedDb(['test@example.com']);

        it('signs and verifies JWTs', async () => {
                const jwt = await signSession('alice@example.com');
                expect(await verifySession(jwt)).toBe('alice@example.com');
                const originalNow = Date.now;
                Date.now = () => (SESSION_MAXAGE + 1) * 1000 + originalNow();
                expect(await verifySession(jwt)).toBeNull();
                Date.now = originalNow;
        });

        it('serves the story viewer (unit style)', async () => {
                const jwt = await signSession('test@example.com');
                const request = new IncomingRequest('http://example.com', { headers: { cookie: `session=${jwt}` } });
                const ctx = createExecutionContext();
                const response = await worker.fetch(request, env, ctx);
                await waitOnExecutionContext(ctx);
                const body = await response.text();
                expect(body).toContain('<div id="root"></div>');
        });

        it('serves the story viewer (integration style)', async () => {
                const jwt = await signSession('test@example.com');
                const response = await SELF.fetch(new Request('https://example.com', { headers: { cookie: `session=${jwt}` } }));
                const body = await response.text();
                expect(body).toContain('<div id="root"></div>');
        });

        it('serves the submit page', async () => {
                const jwt = await signSession('test@example.com');
                const response = await SELF.fetch(new Request('https://example.com/submit', { headers: { cookie: `session=${jwt}` } }));
                const body = await response.text();
                expect(body).toContain('Add Story');
        });

        it('serves the submit page with trailing slash', async () => {
                const jwt = await signSession('test@example.com');
                const response = await SELF.fetch(new Request('https://example.com/submit/', { headers: { cookie: `session=${jwt}` } }));
                const body = await response.text();
                expect(body).toContain('Add Story');
        });

        it('serves the manage page', async () => {
                const jwt = await signSession('test@example.com');
                const response = await SELF.fetch(new Request('https://example.com/manage', { headers: { cookie: `session=${jwt}` } }));
                const body = await response.text();
                expect(body).toContain('Manage Stories');
                expect(body).toContain('Submit New Story');
        });

        it('serves the manage page with trailing slash', async () => {
                const jwt = await signSession('test@example.com');
                const response = await SELF.fetch(new Request('https://example.com/manage/', { headers: { cookie: `session=${jwt}` } }));
                const body = await response.text();
                expect(body).toContain('Manage Stories');
                expect(body).toContain('Submit New Story');
        });
});
