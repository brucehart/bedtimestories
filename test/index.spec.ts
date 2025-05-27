import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker, { signSession, verifySession, SESSION_MAXAGE } from '../src/index';

interface Story {
    id: number;
    title: string;
    content: string;
    date: string;
    image_url: string | null;
    created: string | null;
    updated: string | null;
}

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

function createDb(emails: string[], stories: Story[]) {
    return {
        prepare(query: string) {
            return {
                bind(...params: any[]) {
                    return {
                        async first<T>() {
                            if (query.includes('FROM allowed_accounts')) {
                                const email = params[0] as string;
                                return emails.map(e => e.toLowerCase()).includes(email.toLowerCase()) ? ({} as T) : null;
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

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Story page', () => {
        env.GOOGLE_CLIENT_ID = 'test';
        env.GOOGLE_CLIENT_SECRET = 'test';
        env.DB = createDb(['test@example.com'], []);

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

        it('hides future stories from default endpoint', async () => {
                const past = { id: 1, title: 'Past', content: '', date: new Date('2020-01-01').toISOString(), image_url: null, created: null, updated: null };
                const future = { id: 2, title: 'Future', content: '', date: new Date(Date.now() + 86400000).toISOString(), image_url: null, created: null, updated: null };
                env.DB = createDb(['test@example.com'], [past, future]);
                const jwt = await signSession('test@example.com', env);
                const response = await SELF.fetch(new Request('https://example.com/stories', { headers: { cookie: `session=${jwt}` } }));
                const story = await response.json<any>();
                expect(story.id).toBe(past.id);
        });
});
