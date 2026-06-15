import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker, { signSession, verifySession, SESSION_MAXAGE } from '../src/index';
import { getAccountRole } from '../src/auth';
import { signState } from '../src/session';
import { sha256Hex } from '../src/security';
import { STORY_AGENT_RUNNER } from '../src/storyAgentRunner';

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

interface AgentJob {
    id: string;
    requested_by: string;
    prompt: string;
    target_date: string | null;
    status: string;
    sprite_name: string;
    sprite_session_id: string | null;
    story_id: number | null;
    title: string | null;
    error: string | null;
    callback_token_hash: string;
    created: string | null;
    updated: string | null;
    started: string | null;
    completed: string | null;
}

interface AgentRef {
    id: number;
    job_id: string;
    r2_key: string;
    filename: string;
    content_type: string;
}

interface AgentEvent {
    id: number;
    job_id: string;
    event_type: string;
    message: string;
    metadata: string | null;
    created: string | null;
}

interface AgentMessage {
    id: number;
    job_id: string;
    author_email: string;
    content: string;
    created: string | null;
}

interface AgentState {
    jobs: AgentJob[];
    refs: AgentRef[];
    events: AgentEvent[];
    messages: AgentMessage[];
    nextRefId: number;
    nextEventId: number;
    nextMessageId: number;
}

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

function updateAgentJobFromQuery(query: string, params: any[], job: AgentJob) {
    const setPart = query.match(/SET (.+) WHERE id = \?\d+/)?.[1] || '';
    const assignments = setPart.split(',').map(part => part.trim()).filter(Boolean);
    let paramIndex = 0;
    const now = new Date().toISOString();
    for (const assignment of assignments) {
        const field = assignment.split('=')[0].trim() as keyof AgentJob;
        if (assignment.includes('?')) {
            (job as any)[field] = params[paramIndex++];
        } else if (field === 'updated') {
            job.updated = now;
        } else if (field === 'started') {
            job.started = job.started || now;
        } else if (field === 'completed') {
            job.completed = job.completed || now;
        }
    }
}

function createDb(accounts: (string | Account)[], stories: Story[], agentState?: AgentState) {
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
                            if (agentState && query.startsWith('SELECT * FROM story_agent_jobs WHERE id = ?1')) {
                                return (agentState.jobs.find(job => job.id === params[0]) ?? null) as T;
                            }
                            if (agentState && query.includes('FROM story_agent_refs WHERE job_id = ?1 AND id = ?2')) {
                                return (agentState.refs.find(ref => ref.job_id === params[0] && ref.id === params[1]) ?? null) as T;
                            }
                            return null as T;
                        },
                        async all<T>() {
                            if (agentState && query.includes('FROM story_agent_jobs WHERE LOWER(requested_by)')) {
                                const email = (params[0] as string).toLowerCase();
                                return {
                                    results: agentState.jobs
                                        .filter(job => job.requested_by.toLowerCase() === email)
                                        .sort((a, b) => (b.created || '').localeCompare(a.created || ''))
                                        .slice(0, 10) as T[]
                                };
                            }
                            if (agentState && query.includes('FROM story_agent_events WHERE job_id = ?1')) {
                                const jobId = params[0] as string;
                                const after = params[1] as number;
                                return {
                                    results: agentState.events
                                        .filter(event => event.job_id === jobId && event.id > after)
                                        .sort((a, b) => a.id - b.id)
                                        .slice(0, 100)
                                        .map(({ id, event_type, message, metadata, created }) => ({ id, event_type, message, metadata, created })) as T[]
                                };
                            }
                            if (agentState && query.includes('FROM story_agent_refs WHERE job_id = ?1 ORDER BY id ASC')) {
                                const jobId = params[0] as string;
                                return {
                                    results: agentState.refs
                                        .filter(ref => ref.job_id === jobId)
                                        .sort((a, b) => a.id - b.id)
                                        .map(({ id, filename, content_type }) => ({ id, filename, content_type })) as T[]
                                };
                            }
                            if (agentState && query.includes('FROM story_agent_messages WHERE job_id = ?1')) {
                                const jobId = params[0] as string;
                                const after = params[1] as number;
                                return {
                                    results: agentState.messages
                                        .filter(message => message.job_id === jobId && message.id > after)
                                        .sort((a, b) => a.id - b.id)
                                        .slice(0, 25)
                                        .map(({ id, author_email, content, created }) => ({ id, author_email, content, created })) as T[]
                                };
                            }
                            return { results: stories as T[] };
                        },
                        async run() {
                            if (agentState && query.startsWith('INSERT INTO story_agent_jobs')) {
                                const now = new Date().toISOString();
                                agentState.jobs.push({
                                    id: params[0],
                                    requested_by: params[1],
                                    prompt: params[2],
                                    target_date: params[3],
                                    status: params[4],
                                    sprite_name: params[5],
                                    callback_token_hash: params[6],
                                    sprite_session_id: null,
                                    story_id: null,
                                    title: null,
                                    error: null,
                                    created: now,
                                    updated: now,
                                    started: null,
                                    completed: null
                                });
                                return { meta: { last_row_id: 1 } };
                            }
                            if (agentState && query.startsWith('INSERT INTO story_agent_refs')) {
                                agentState.refs.push({
                                    id: agentState.nextRefId++,
                                    job_id: params[0],
                                    r2_key: params[1],
                                    filename: params[2],
                                    content_type: params[3]
                                });
                                return { meta: { last_row_id: agentState.nextRefId - 1 } };
                            }
                            if (agentState && query.startsWith('INSERT INTO story_agent_events')) {
                                agentState.events.push({
                                    id: agentState.nextEventId++,
                                    job_id: params[0],
                                    event_type: params[1],
                                    message: params[2],
                                    metadata: params[3],
                                    created: new Date().toISOString()
                                });
                                return { meta: { last_row_id: agentState.nextEventId - 1 } };
                            }
                            if (agentState && query.startsWith('INSERT INTO story_agent_messages')) {
                                agentState.messages.push({
                                    id: agentState.nextMessageId++,
                                    job_id: params[0],
                                    author_email: params[1],
                                    content: params[2],
                                    created: new Date().toISOString()
                                });
                                return { meta: { last_row_id: agentState.nextMessageId - 1 } };
                            }
                            if (agentState && query.startsWith('UPDATE story_agent_jobs SET')) {
                                const jobId = params[params.length - 1];
                                const job = agentState.jobs.find(j => j.id === jobId);
                                if (job) updateAgentJobFromQuery(query, params, job);
                                return { meta: { last_row_id: 1 } };
                            }
                            return { meta: { last_row_id: 1 } };
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
        async get(key: string, _options?: R2GetOptions) {
            const value = store[key];
            if (!value) return null;
            const encoded = new TextEncoder().encode(value);
            const body = new ReadableStream({
                start(controller) {
                    controller.enqueue(encoded);
                    controller.close();
                }
            });
            return {
                body,
                size: encoded.byteLength,
                writeHttpMetadata(_h: Headers) {},
                httpEtag: 'test-etag'
            } as unknown as R2ObjectBody;
        }
    } as unknown as R2Bucket;
}

function createImagesPutSpy() {
    let lastPut: { key: string; value: unknown; options?: unknown } | null = null;
    const bucket = {
        async put(key: string, value: unknown, options?: unknown) {
            lastPut = { key, value, options };
        }
    } as unknown as R2Bucket;
    return { bucket, getLastPut: () => lastPut };
}

function createAgentImages() {
    const store = new Map<string, { value: Uint8Array; contentType: string }>();
    const bucket = {
        async put(key: string, value: unknown, options?: any) {
            let bytes = new Uint8Array();
            if (value instanceof ReadableStream) {
                const chunks: Uint8Array[] = [];
                const reader = value.getReader();
                while (true) {
                    const { done, value: chunk } = await reader.read();
                    if (done) break;
                    chunks.push(chunk);
                }
                const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
                bytes = new Uint8Array(size);
                let offset = 0;
                for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.byteLength;
                }
            }
            store.set(key, {
                value: bytes,
                contentType: options?.httpMetadata?.contentType || 'application/octet-stream'
            });
        },
        async get(key: string) {
            const item = store.get(key);
            if (!item) return null;
            return {
                body: new ReadableStream({
                    start(controller) {
                        controller.enqueue(item.value);
                        controller.close();
                    }
                }),
                size: item.value.byteLength,
                writeHttpMetadata(headers: Headers) {
                    headers.set('Content-Type', item.contentType);
                },
                httpEtag: 'agent-etag'
            } as unknown as R2ObjectBody;
        },
        async delete(key: string) {
            store.delete(key);
        }
    } as unknown as R2Bucket;
    return { bucket, store };
}

function createAgentState(): AgentState {
    return {
        jobs: [],
        refs: [],
        events: [],
        messages: [],
        nextRefId: 1,
        nextEventId: 1,
        nextMessageId: 1
    };
}

function createImagesWithCounter(store: Record<string, string>) {
    let count = 0;
    const bucket = {
        async get(key: string, options?: R2GetOptions) {
            count++;
            const value = store[key];
            if (!value) return null;
            const encoded = new TextEncoder().encode(value);

            let rangeValue: R2Range | undefined;
            let slice = encoded;

            if (options?.range instanceof Headers) {
                const hdr = options.range.get('range');
                if (hdr?.startsWith('bytes=')) {
                    const [startStr, endStr] = hdr.replace('bytes=', '').split('-');
                    const start = Number(startStr);
                    const end = endStr ? Number(endStr) : encoded.byteLength - 1;
                    const safeStart = Number.isFinite(start) ? Math.max(0, start) : 0;
                    const safeEnd = Number.isFinite(end)
                        ? Math.min(encoded.byteLength - 1, end)
                        : encoded.byteLength - 1;
                    slice = encoded.subarray(safeStart, safeEnd + 1);
                    rangeValue = { offset: safeStart, length: slice.byteLength };
                }
            }

            const body = new ReadableStream({
                start(controller) {
                    controller.enqueue(slice);
                    controller.close();
                }
            });
            const obj: any = {
                body,
                size: encoded.byteLength,
                writeHttpMetadata(_h: Headers) {},
                httpEtag: 'test-etag'
            };
            if (rangeValue) obj.range = rangeValue;
            return obj as R2ObjectBody;
        }
    } as unknown as R2Bucket;
    return { bucket, getCount: () => count };
}

async function workerFetch(url: string | Request, init?: RequestInit) {
    const req = url instanceof Request ? url : new Request(url, init);
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    return resp;
}

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Story page', () => {
        beforeEach(() => {
                env.GOOGLE_CLIENT_ID = 'test';
                env.GOOGLE_CLIENT_SECRET = 'test';
                env.OAUTH_CALLBACK_URL = 'https://auth.example.com/oauth/callback';
                env.SESSION_HMAC_KEY = 'test-hmac-key';
                env.DB = createDb(['test@example.com'], []);
                env.IMAGES = createImages({});
                env.PUBLIC_VIEW = 'false';
                delete (env as any).STORY_AGENT_ALLOWED_EMAILS;
                delete (env as any).AGENT_ALLOWED_EMAILS;
                delete (env as any).SPRITES_API_TOKEN;
                delete (env as any).SPRITE_API_TOKEN;
                delete (env as any).STORY_AGENT_SPRITES_API_BASE;
                delete (env as any).STORY_AGENT_SPRITE_NAME;
                delete (env as any).STORY_AGENT_SPRITE_WORKDIR;
        });

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
                expect(response.headers.get('X-Frame-Options')).toBe('DENY');
                expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
        });

        it('serves the story viewer (integration style)', async () => {
                const jwt = await signSession('test@example.com', env);
                const response = await SELF.fetch(new Request('https://example.com', { headers: { cookie: `session=${jwt}` } }), env);
                const body = await response.text();
                expect(body).toContain('<div id="root"></div>');
        });

        it('serves the submit page', async () => {
                const jwt = await signSession('test@example.com', env);
                const response = await workerFetch('https://example.com/submit', { headers: { cookie: `session=${jwt}` } });
                const body = await response.text();
                expect(body).toContain('Add Story');
        });

        it('serves the submit page with trailing slash', async () => {
                const jwt = await signSession('test@example.com', env);
                const response = await workerFetch('https://example.com/submit/', { headers: { cookie: `session=${jwt}` } });
                const body = await response.text();
                expect(body).toContain('Add Story');
        });

        it('serves the manage page', async () => {
                const jwt = await signSession('test@example.com', env);
                const response = await workerFetch('https://example.com/manage', { headers: { cookie: `session=${jwt}` } });
                const body = await response.text();
                expect(body).toContain('Manage Stories');
                expect(body).toContain('Submit New Story');
                expect(response.headers.get('Cache-Control')).toBe('no-store');
                expect(response.headers.get('X-Frame-Options')).toBe('DENY');
        });

        it('serves the manage page with trailing slash', async () => {
                const jwt = await signSession('test@example.com', env);
                const response = await workerFetch('https://example.com/manage/', { headers: { cookie: `session=${jwt}` } });
                const body = await response.text();
                expect(body).toContain('Manage Stories');
                expect(body).toContain('Submit New Story');
        });

        it('denies reader accounts access to editor pages', async () => {
                env.DB = createDb([{ email: 'reader@example.com', role: 'reader' }], []);
                const jwt = await signSession('reader@example.com', env);
                expect(await verifySession(jwt, env)).toBe('reader@example.com');
                expect(await getAccountRole('reader@example.com', env)).toBe('reader');
                const resp = await workerFetch('https://example.com/submit', { headers: { cookie: `session=${jwt}` } });
                expect(resp.status).toBe(403);
        });

        it('hides future stories from default endpoint', async () => {
                const past = { id: 1, title: 'Past', content: '', date: new Date('2020-01-01').toISOString(), image_url: null, video_url: null, created: null, updated: null };
                const future = { id: 2, title: 'Future', content: '', date: new Date(Date.now() + 86400000).toISOString(), image_url: null, video_url: null, created: null, updated: null };
                env.DB = createDb(['test@example.com'], [past, future]);
                const jwt = await signSession('test@example.com', env);
                const response = await workerFetch('https://example.com/stories', { headers: { cookie: `session=${jwt}` } });
                const story = await response.json<any>();
                expect(story.id).toBe(past.id);
        });

        it('allows viewing without login when PUBLIC_VIEW is true', async () => {
                env.PUBLIC_VIEW = 'true';
                const response = await workerFetch('https://example.com/');
                const body = await response.text();
                expect(body).toContain('<div id="root"></div>');
        });

        it('requires login for manage page even when PUBLIC_VIEW is true', async () => {
                env.PUBLIC_VIEW = 'true';
                const response = await workerFetch(new Request('https://example.com/manage', { redirect: 'manual' }));
                expect(response.status).toBe(302);
                expect(response.headers.get('Location')).toBe('/login');
        });

        it('requires login for submit page even when PUBLIC_VIEW is true', async () => {
                env.PUBLIC_VIEW = 'true';
                const response = await workerFetch(new Request('https://example.com/submit', { redirect: 'manual' }));
                expect(response.status).toBe(302);
                expect(response.headers.get('Location')).toBe('/login');
        });

        it('serves images from the R2 bucket', async () => {
                env.IMAGES = createImages({ 'foo.txt': 'hello' });
                const jwt = await signSession('test@example.com', env);
                const response = await workerFetch('https://example.com/images/foo.txt', { headers: { cookie: `session=${jwt}` } });
                expect(await response.text()).toBe('hello');
                expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
                expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
        });

        it('caches media responses in the default cache', async () => {
                const key = `cached-${Date.now()}`;
                const { bucket, getCount } = createImagesWithCounter({ [key]: 'hello-cache' });
                env.IMAGES = bucket;
                env.PUBLIC_VIEW = 'true';
                const url = `https://example.com/images/${key}`;
                const first = await workerFetch(url);
                expect(await first.text()).toBe('hello-cache');
                expect(getCount()).toBe(1);
                const second = await workerFetch(url);
                expect(await second.text()).toBe('hello-cache');
                expect(getCount()).toBe(1);
        });

        it('supports range requests for media', async () => {
                const key = `range-${Date.now()}`;
                const { bucket } = createImagesWithCounter({ [key]: 'helloworld' });
                env.IMAGES = bucket;
                env.PUBLIC_VIEW = 'true';
                const response = await workerFetch(new Request(`https://example.com/images/${key}`, { headers: { range: 'bytes=0-3' } }));
                expect(response.status).toBe(206);
                expect(response.headers.get('Content-Range')).toBe('bytes 0-3/10');
                expect(response.headers.get('Accept-Ranges')).toBe('bytes');
                expect(await response.text()).toBe('hell');
        });

        it('allows image access without login when PUBLIC_VIEW is true', async () => {
                env.PUBLIC_VIEW = 'true';
                env.IMAGES = createImages({ 'foo.txt': 'world' });
                const response = await workerFetch('https://example.com/images/foo.txt');
                expect(await response.text()).toBe('world');
                expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
        });

        it('rejects malformed percent-encoding in image keys', async () => {
                env.PUBLIC_VIEW = 'true';
                env.IMAGES = createImages({ });
                const response = await workerFetch('https://example.com/images/%E0%A4%A');
                expect(response.status).toBe(400);
        });

        it('rejects invalid image key characters', async () => {
                env.PUBLIC_VIEW = 'true';
                env.IMAGES = createImages({ });
                // Avoid URL path normalization of ".." segments by encoding slashes.
                const response = await workerFetch('https://example.com/images/..%2F..%2Fetc%2Fpasswd');
                expect(response.status).toBe(400);
        });

        it('locks down /update-cache when token is not configured', async () => {
                delete (env as any).CACHE_REFRESH_TOKEN;
                const response = await workerFetch('https://example.com/update-cache');
                expect(response.status).toBe(503);
        });

        it('requires bearer auth for /update-cache when token is configured', async () => {
                env.CACHE_REFRESH_TOKEN = 'cache-token';
                let response = await workerFetch('https://example.com/update-cache');
                expect(response.status).toBe(403);
                response = await workerFetch('https://example.com/update-cache', { headers: { Authorization: 'Bearer wrong' } });
                expect(response.status).toBe(403);
                response = await workerFetch('https://example.com/update-cache', { headers: { Authorization: 'Bearer cache-token' } });
                expect(response.status).toBe(200);
        });

        it('does not leak session tokens in OAuth callback redirect locations', async () => {
                const originalFetch = globalThis.fetch;
                globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
                        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
                        if (url === 'https://oauth2.googleapis.com/token') {
                                return new Response(JSON.stringify({ id_token: 'test-token' }), {
                                        status: 200,
                                        headers: { 'content-type': 'application/json' }
                                });
                        }
                        return originalFetch(input as any, init);
                }) as any;
                try {
                        const state = await signState('https://example.com', env);
                        const response = await workerFetch(new Request(`https://example.com/oauth/callback?code=test-code&state=${encodeURIComponent(state)}`, { redirect: 'manual' }));
                        expect(response.status).toBe(302);
                        expect(response.headers.get('Set-Cookie') || '').toContain('session=');
                        const location = response.headers.get('Location') || '';
                        expect(location).not.toContain('token=');
                        expect(response.headers.get('Cache-Control')).toBe('no-store');
                        expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
                } finally {
                        globalThis.fetch = originalFetch;
                }
        });

        it('validates /stories/list query parameters', async () => {
                const jwt = await signSession('test@example.com', env);
                let response = await workerFetch('https://example.com/stories/list?page=0', { headers: { cookie: `session=${jwt}` } });
                expect(response.status).toBe(400);
                const longQ = 'a'.repeat(201);
                response = await workerFetch(`https://example.com/stories/list?q=${longQ}`, { headers: { cookie: `session=${jwt}` } });
                expect(response.status).toBe(400);
                response = await workerFetch('https://example.com/stories/list?date=not-a-date', { headers: { cookie: `session=${jwt}` } });
                expect(response.status).toBe(400);
        });

        it('hardens /api/media uploads (type/size limits + streaming)', async () => {
                env.STORY_API_TOKEN = 'story-token';
                const { bucket, getLastPut } = createImagesPutSpy();
                env.IMAGES = bucket;

                const bad = new FormData();
                bad.set('file', new File([new Uint8Array([1, 2, 3])], 'x.txt', { type: 'text/plain' }));
                let response = await workerFetch(new Request('https://example.com/api/media', { method: 'POST', body: bad, headers: { 'X-Story-Token': 'story-token' } }));
                expect(response.status).toBe(415);

                const tooBigBytes = new Uint8Array(10 * 1024 * 1024 + 1);
                const tooBig = new FormData();
                tooBig.set('file', new File([tooBigBytes], 'x.jpg', { type: 'image/jpeg' }));
                response = await workerFetch(new Request('https://example.com/api/media', { method: 'POST', body: tooBig, headers: { 'X-Story-Token': 'story-token' } }));
                expect(response.status).toBe(413);

                const ok = new FormData();
                ok.set('file', new File([new Uint8Array([1, 2, 3, 4])], 'x.jpg', { type: 'image/jpeg' }));
                response = await workerFetch(new Request('https://example.com/api/media', { method: 'POST', body: ok, headers: { 'X-Story-Token': 'story-token' } }));
                expect(response.status).toBe(200);
                const put = getLastPut();
                expect(put).not.toBeNull();
                expect(put!.value).toBeInstanceOf(ReadableStream);
                expect((put!.options as any)?.httpMetadata?.contentType).toBe('image/jpeg');
        });

        it('returns 400 for invalid dates on /stories form endpoints', async () => {
                const jwt = await signSession('test@example.com', env);
                const data = new FormData();
                data.set('title', 'T');
                data.set('content', 'C');
                data.set('date', 'not-a-date');
                const response = await workerFetch(new Request('https://example.com/stories', { method: 'POST', body: data, headers: { cookie: `session=${jwt}` } }));
                expect(response.status).toBe(400);
        });

        it('requires the separate story agent allowlist for agent endpoints', async () => {
                const agentState = createAgentState();
                env.DB = createDb(['test@example.com'], [], agentState);
                const jwt = await signSession('test@example.com', env);

                let response = await workerFetch('https://example.com/agent/jobs', { headers: { cookie: `session=${jwt}` } });
                expect(response.status).toBe(503);

                env.STORY_AGENT_ALLOWED_EMAILS = 'owner@example.com';
                response = await workerFetch('https://example.com/agent/jobs', { headers: { cookie: `session=${jwt}` } });
                expect(response.status).toBe(403);

                env.STORY_AGENT_ALLOWED_EMAILS = 'test@example.com';
                response = await workerFetch('https://example.com/agent/jobs', { headers: { cookie: `session=${jwt}` } });
                expect(response.status).toBe(200);
        });

        it('creates story agent jobs and launches the configured Sprite', async () => {
                const originalFetch = globalThis.fetch;
                const spriteRequests: string[] = [];
                globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
                        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
                        if (url.startsWith('https://api.sprites.dev/')) {
                                spriteRequests.push(url);
                                expect(init?.headers).toEqual({ Authorization: 'Bearer sprites-token' });
                                return Response.json({ ok: true });
                        }
                        return originalFetch(input as any, init);
                }) as any;

                try {
                        const agentState = createAgentState();
                        const { bucket, store } = createAgentImages();
                        env.DB = createDb(['test@example.com'], [], agentState);
                        env.IMAGES = bucket;
                        env.STORY_AGENT_ALLOWED_EMAILS = 'test@example.com';
                        env.SPRITES_API_TOKEN = 'sprites-token';
                        const jwt = await signSession('test@example.com', env);
                        const data = new FormData();
                        data.set('prompt', 'A cozy moon train story');
                        data.set('date', '2026-06-16');
                        data.append('ref_images', new File([new Uint8Array([1, 2, 3])], 'moon.jpg', { type: 'image/jpeg' }));

                        const response = await workerFetch(new Request('https://example.com/agent/jobs', {
                                method: 'POST',
                                body: data,
                                headers: { cookie: `session=${jwt}` }
                        }));
                        expect(response.status).toBe(202);
                        const body = await response.json<any>();
                        expect(body.job.status).toBe('starting');
                        expect(agentState.jobs).toHaveLength(1);
                        expect(agentState.jobs[0].status).toBe('starting');
                        expect(agentState.jobs[0].requested_by).toBe('test@example.com');
                        expect(agentState.refs).toHaveLength(1);
                        expect(store.size).toBe(1);
                        expect(spriteRequests).toHaveLength(1);
                        const launchUrl = new URL(spriteRequests[0]);
                        expect(launchUrl.pathname).toBe('/v1/sprites/bedtime-stories/exec');
                        expect(launchUrl.searchParams.getAll('cmd').join(' ')).toContain('story-agent-');
                        expect(launchUrl.searchParams.getAll('cmd').join(' ')).toContain('STORY_AGENT_TASK_NAME=');
                        expect(launchUrl.searchParams.getAll('cmd').join(' ')).toContain("printf '%s\\n'");
                        expect(launchUrl.searchParams.getAll('cmd').join(' ')).toContain('Mozilla/5.0');
                        expect(launchUrl.searchParams.getAll('cmd').join(' ')).not.toContain('STORY_AGENT_ENV');
                        expect(launchUrl.searchParams.getAll('cmd').join(' ')).not.toContain('& &&');
                        expect(agentState.events.some(event => event.message.includes('launch command accepted'))).toBe(true);
                } finally {
                        globalThis.fetch = originalFetch;
                }
        });

        it('authenticates runner callbacks with the per-job token', async () => {
                const token = 'runner-token';
                const jobId = 'job_1234567890123456';
                const agentState = createAgentState();
                agentState.jobs.push({
                        id: jobId,
                        requested_by: 'test@example.com',
                        prompt: 'A small garden rocket',
                        target_date: '2026-06-16',
                        status: 'running',
                        sprite_name: 'bedtime-stories',
                        sprite_session_id: null,
                        story_id: null,
                        title: null,
                        error: null,
                        callback_token_hash: await sha256Hex(token),
                        created: new Date().toISOString(),
                        updated: new Date().toISOString(),
                        started: null,
                        completed: null
                });
                agentState.refs.push({ id: 1, job_id: jobId, r2_key: 'ref.jpg', filename: 'ref.jpg', content_type: 'image/jpeg' });
                env.DB = createDb(['test@example.com'], [], agentState);
                env.IMAGES = createImages({ 'ref.jpg': 'ref-data' });
                env.STORY_AGENT_ALLOWED_EMAILS = 'test@example.com';
                const jwt = await signSession('test@example.com', env);

                let response = await workerFetch(`https://example.com/api/agent/jobs/${jobId}/bootstrap`);
                expect(response.status).toBe(401);

                response = await workerFetch(`https://example.com/api/agent/jobs/${jobId}/bootstrap`, {
                        headers: { Authorization: `Bearer ${token}` }
                });
                expect(response.status).toBe(200);
                const bootstrap = await response.json<any>();
                expect(bootstrap.prompt).toBe('A small garden rocket');
                expect(bootstrap.refs[0].url).toBe(`/api/agent/jobs/${jobId}/refs/1`);

                response = await workerFetch(`https://example.com/api/agent/jobs/${jobId}/refs/1`, {
                        headers: { Authorization: `Bearer ${token}` }
                });
                expect(await response.text()).toBe('ref-data');

                response = await workerFetch(`https://example.com/agent/jobs/${jobId}/messages`, {
                        method: 'POST',
                        headers: { cookie: `session=${jwt}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content: 'Make it gentler.' })
                });
                expect(response.status).toBe(200);

                response = await workerFetch(`https://example.com/api/agent/jobs/${jobId}/messages?after=0`, {
                        headers: { Authorization: `Bearer ${token}` }
                });
                const messages = await response.json<any>();
                expect(messages.messages[0].content).toBe('Make it gentler.');

                response = await workerFetch(`https://example.com/api/agent/jobs/${jobId}/events`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ type: 'log', message: 'working' })
                });
                expect(response.status).toBe(200);

                response = await workerFetch(`https://example.com/api/agent/jobs/${jobId}`, {
                        method: 'PATCH',
                        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: 'complete', story_id: 42, title: 'Garden Rocket' })
                });
                expect(response.status).toBe(200);
                expect(agentState.jobs[0].status).toBe('complete');
                expect(agentState.jobs[0].story_id).toBe(42);

                response = await workerFetch(`https://example.com/agent/jobs/${jobId}/events`, {
                        headers: { cookie: `session=${jwt}` }
                });
                const events = await response.text();
                expect(events).toContain('event: log');
                expect(events).toContain('event: complete');
        });

        it('cancels active story agent jobs and asks Sprite to stop the runner', async () => {
                const originalFetch = globalThis.fetch;
                const spriteRequests: string[] = [];
                globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
                        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
                        if (url.startsWith('https://api.sprites.dev/')) {
                                spriteRequests.push(url);
                                return Response.json({ ok: true });
                        }
                        return originalFetch(input as any, init);
                }) as any;

                try {
                        const jobId = 'job_ABCdef1234567890';
                        const agentState = createAgentState();
                        agentState.jobs.push({
                                id: jobId,
                                requested_by: 'test@example.com',
                                prompt: 'A train story',
                                target_date: null,
                                status: 'running',
                                sprite_name: 'bedtime-stories',
                                sprite_session_id: null,
                                story_id: null,
                                title: null,
                                error: null,
                                callback_token_hash: await sha256Hex('runner-token'),
                                created: new Date().toISOString(),
                                updated: new Date().toISOString(),
                                started: null,
                                completed: null
                        });
                        env.DB = createDb(['test@example.com'], [], agentState);
                        env.STORY_AGENT_ALLOWED_EMAILS = 'test@example.com';
                        env.SPRITES_API_TOKEN = 'sprites-token';
                        const jwt = await signSession('test@example.com', env);

                        const response = await workerFetch(`https://example.com/agent/jobs/${jobId}/cancel`, {
                                method: 'POST',
                                headers: { cookie: `session=${jwt}` }
                        });
                        expect(response.status).toBe(200);
                        expect(agentState.jobs[0].status).toBe('canceled');
                        expect(spriteRequests).toHaveLength(1);
                        expect(new URL(spriteRequests[0]).searchParams.getAll('cmd').join(' ')).toContain(jobId);
                        expect(new URL(spriteRequests[0]).searchParams.getAll('cmd').join(' ')).toContain('http://sprite/v1/tasks/story-agent-job-abcdef1234567890');
                } finally {
                        globalThis.fetch = originalFetch;
                }
        });

        it('ignores late runner status updates after cancellation', async () => {
                const token = 'runner-token';
                const jobId = 'job_latecancel123456';
                const agentState = createAgentState();
                agentState.jobs.push({
                        id: jobId,
                        requested_by: 'test@example.com',
                        prompt: 'A train story',
                        target_date: null,
                        status: 'canceled',
                        sprite_name: 'bedtime-stories',
                        sprite_session_id: null,
                        story_id: null,
                        title: null,
                        error: null,
                        callback_token_hash: await sha256Hex(token),
                        created: new Date().toISOString(),
                        updated: new Date().toISOString(),
                        started: null,
                        completed: new Date().toISOString()
                });
                env.DB = createDb(['test@example.com'], [], agentState);

                const response = await workerFetch(`https://example.com/api/agent/jobs/${jobId}`, {
                        method: 'PATCH',
                        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: 'complete', story_id: 42, title: 'Too Late' })
                });
                expect(response.status).toBe(200);
                const body = await response.json<any>();
                expect(body.ignored).toBe(true);
                expect(agentState.jobs[0].status).toBe('canceled');
                expect(agentState.jobs[0].story_id).toBeNull();
                expect(agentState.jobs[0].title).toBeNull();
        });

        it('passes Sprite reference image paths into Codex and generate-story', () => {
                expect(STORY_AGENT_RUNNER).toContain('Reference images are available at the /tmp paths above');
                expect(STORY_AGENT_RUNNER).toContain('--ref-image');
                expect(STORY_AGENT_RUNNER).not.toContain('cmd.extend(["--image", ref_path])');
                expect(STORY_AGENT_RUNNER).not.toContain('STORY_AGENT_RESULT_JSON={');
                expect(STORY_AGENT_RUNNER).not.toContain('"story_id":123');
                expect(STORY_AGENT_RUNNER).toContain('output_dir / (str(ref.get("id", len(paths) + 1)) + "-" + safe_name)');
                expect(STORY_AGENT_RUNNER).toContain('pty.openpty()');
                expect(STORY_AGENT_RUNNER).toContain('os.write(');
                expect(STORY_AGENT_RUNNER).not.toContain('stdin=subprocess.DEVNULL');
                expect(STORY_AGENT_RUNNER).toContain('"exec"');
                expect(STORY_AGENT_RUNNER).toContain('"--color"');
                expect(STORY_AGENT_RUNNER).toContain('"--output-last-message"');
                expect(STORY_AGENT_RUNNER).not.toContain('"--no-alt-screen"');
                expect(STORY_AGENT_RUNNER).toContain('STORY_AGENT_TASK_NAME');
                expect(STORY_AGENT_RUNNER).toContain('("story-agent-" + JOB_ID).lower()');
                expect(STORY_AGENT_RUNNER).toContain('"User-Agent": USER_AGENT');
                expect(STORY_AGENT_RUNNER).toContain('headers={"Authorization": "Bearer " + JOB_TOKEN, "User-Agent": USER_AGENT}');
        });
});
