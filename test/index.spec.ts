import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker, { signSession, verifySession, SESSION_MAXAGE } from '../src/index';

interface Story {
    id: number;
    title: string;
    content: string;
    date: string;
    image_url: string | null;
    video_url: string | null;
    created: string | null;
    updated: string | null;
}

type Account = { email: string; role: 'reader' | 'editor' };

function normalizeAccounts(accounts: (string | Account)[]): Account[] {
    return accounts.map(a =>
        typeof a === 'string' ? { email: a, role: 'editor' } : a
    );
}

function createAllowedDb(accounts: (string | Account)[]) {
    const acc = normalizeAccounts(accounts);
    return {
        prepare(query: string) {
            return {
                bind(email?: string) {
                    return {
                        async first<T>() {
                            if (query.includes('COUNT(*)')) {
                                return { count: acc.length } as T;
                            }
                            const row = acc.find(a => a.email.toLowerCase() === (email ?? '').toLowerCase());
                            return row ? ({ role: row.role } as T) : null;
                        }
                    };
                }
            };
        }
    } as unknown as D1Database;
}

function createDb(accounts: (string | Account)[], stories: Story[]) {
    const acc = normalizeAccounts(accounts);
    return {
        prepare(query: string) {
            return {
                bind(...params: any[]) {
                    return {
                        async first<T>() {
                            if (query.includes('FROM allowed_accounts')) {
                                const email = params[0] as string;
                                const row = acc.find(a => a.email.toLowerCase() === email.toLowerCase());
                                return row ? ({ role: row.role } as T) : null;
                            }
                            if (query.includes('WHERE date <= ?1')) {
                                const nowIso = params[0] as string;
                                const filtered = stories
                                    .filter(s => s.date <= nowIso)
                                    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
                                return (filtered[0] ?? null) as T;
                            }
                            if (query.startsWith('SELECT * FROM stories WHERE id = ?1')) {
                                const id = params[0];
                                return (stories.find(s => s.id === id) ?? null) as T;
                            }
                            return null as T;
                        }
                    };
                },
                async all<T>() {
                    return { results: stories as T[] };
                }
            };
        }
    } as unknown as D1Database;
}

function createImages(store: Record<string, string>) {
    return {
        async get(key: string) {
            const value = store[key];
            if (!value) return null;
            const body = new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(value));
                    controller.close();
                }
            });
            return {
                body,
                writeHttpMetadata(_h: Headers) {},
                httpEtag: 'test-etag'
            } as unknown as R2ObjectBody;
        }
    } as unknown as R2Bucket;
}

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Story page', () => {
        env.GOOGLE_CLIENT_ID = 'test';
        env.GOOGLE_CLIENT_SECRET = 'test';
        env.DB = createDb(['test@example.com'], []);
        env.IMAGES = createImages({});
        env.PUBLIC_VIEW = 'false';

        it('signs and verifies JWTs', async () => {
                const jwt = await signSession('alice@example.com', env);
                expect(await verifySession(jwt, env)).toBe('alice@example.com');
                const originalNow = Date.now;
                Date.now = () => (SESSION_MAXAGE + 1) * 1000 + originalNow();
                expect(await verifySession(jwt, env)).toBeNull();
                Date.now = originalNow;
        });

        it('serves the story viewer (unit style)', async () => {
                const jwt = await signSession('test@example.com', env);
                const request = new IncomingRequest('http://example.com', { headers: { cookie: `session=${jwt}` } });
                const ctx = createExecutionContext();
                const response = await worker.fetch(request, env, ctx);
                await waitOnExecutionContext(ctx);
                const body = await response.text();
                expect(body).toContain('<div id="root"></div>');
        });

        it('serves the story viewer (integration style)', async () => {
                const jwt = await signSession('test@example.com', env);
                const response = await SELF.fetch(new Request('https://example.com', { headers: { cookie: `session=${jwt}` } }));
                const body = await response.text();
                expect(body).toContain('<div id="root"></div>');
        });

        it('serves the submit page', async () => {
                const jwt = await signSession('test@example.com', env);
                const response = await SELF.fetch(new Request('https://example.com/submit', { headers: { cookie: `session=${jwt}` } }));
                const body = await response.text();
                expect(body).toContain('Add Story');
        });

        it('serves the submit page with trailing slash', async () => {
                const jwt = await signSession('test@example.com', env);
                const response = await SELF.fetch(new Request('https://example.com/submit/', { headers: { cookie: `session=${jwt}` } }));
                const body = await response.text();
                expect(body).toContain('Add Story');
        });

        it('serves the manage page', async () => {
                const jwt = await signSession('test@example.com', env);
                const response = await SELF.fetch(new Request('https://example.com/manage', { headers: { cookie: `session=${jwt}` } }));
                const body = await response.text();
                expect(body).toContain('Manage Stories');
                expect(body).toContain('Submit New Story');
        });

        it('serves the manage page with trailing slash', async () => {
                const jwt = await signSession('test@example.com', env);
                const response = await SELF.fetch(new Request('https://example.com/manage/', { headers: { cookie: `session=${jwt}` } }));
                const body = await response.text();
                expect(body).toContain('Manage Stories');
                expect(body).toContain('Submit New Story');
        });

        it('denies reader accounts access to editor pages', async () => {
                env.DB = createDb([{ email: 'reader@example.com', role: 'reader' }], []);
                const jwt = await signSession('reader@example.com', env);
                const resp = await SELF.fetch(new Request('https://example.com/submit', { headers: { cookie: `session=${jwt}` } }));
                expect(resp.status).toBe(403);
        });

        it('hides future stories from default endpoint', async () => {
                const past = { id: 1, title: 'Past', content: '', date: new Date('2020-01-01').toISOString(), image_url: null, video_url: null, created: null, updated: null };
                const future = { id: 2, title: 'Future', content: '', date: new Date(Date.now() + 86400000).toISOString(), image_url: null, video_url: null, created: null, updated: null };
                env.DB = createDb(['test@example.com'], [past, future]);
                const jwt = await signSession('test@example.com', env);
                const response = await SELF.fetch(new Request('https://example.com/stories', { headers: { cookie: `session=${jwt}` } }));
                const story = await response.json<any>();
                expect(story.id).toBe(past.id);
        });

        it('allows viewing without login when PUBLIC_VIEW is true', async () => {
                env.PUBLIC_VIEW = 'true';
                const response = await SELF.fetch(new Request('https://example.com/'));
                const body = await response.text();
                expect(body).toContain('<div id="root"></div>');
        });

        it('requires login for manage page even when PUBLIC_VIEW is true', async () => {
                env.PUBLIC_VIEW = 'true';
                const response = await SELF.fetch(new Request('https://example.com/manage'));
                expect(response.status).toBe(302);
                expect(response.headers.get('Location')).toBe('/login');
        });

        it('requires login for submit page even when PUBLIC_VIEW is true', async () => {
                env.PUBLIC_VIEW = 'true';
                const response = await SELF.fetch(new Request('https://example.com/submit'));
                expect(response.status).toBe(302);
                expect(response.headers.get('Location')).toBe('/login');
        });

        it('serves images from the R2 bucket', async () => {
                env.IMAGES = createImages({ 'foo.txt': 'hello' });
                const jwt = await signSession('test@example.com', env);
                const response = await SELF.fetch(new Request('https://example.com/images/foo.txt', { headers: { cookie: `session=${jwt}` } }));
                expect(await response.text()).toBe('hello');
                expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
        });

        it('allows image access without login when PUBLIC_VIEW is true', async () => {
                env.PUBLIC_VIEW = 'true';
                env.IMAGES = createImages({ 'foo.txt': 'world' });
                const response = await SELF.fetch(new Request('https://example.com/images/foo.txt'));
                expect(await response.text()).toBe('world');
                expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
        });
});
