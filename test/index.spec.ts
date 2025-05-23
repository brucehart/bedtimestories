import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Story page', () => {
        env.GOOGLE_CLIENT_ID = 'test';
        env.GOOGLE_CLIENT_SECRET = 'test';
        env.ALLOWED_ACCOUNTS = 'test@example.com';

        it('serves the story viewer (unit style)', async () => {
                const request = new IncomingRequest('http://example.com', { headers: { cookie: 'session=test-token' } });
                const ctx = createExecutionContext();
                const response = await worker.fetch(request, env, ctx);
                await waitOnExecutionContext(ctx);
                const body = await response.text();
                expect(body).toContain('<div id="root"></div>');
        });

        it('serves the story viewer (integration style)', async () => {
                const response = await SELF.fetch(new Request('https://example.com', { headers: { cookie: 'session=test-token' } }));
                const body = await response.text();
                expect(body).toContain('<div id="root"></div>');
        });

        it('serves the submit page', async () => {
                const response = await SELF.fetch(new Request('https://example.com/submit', { headers: { cookie: 'session=test-token' } }));
                const body = await response.text();
                expect(body).toContain('Add Story');
        });

        it('serves the submit page with trailing slash', async () => {
                const response = await SELF.fetch(new Request('https://example.com/submit/', { headers: { cookie: 'session=test-token' } }));
                const body = await response.text();
                expect(body).toContain('Add Story');
        });

        it('serves the manage page', async () => {
                const response = await SELF.fetch(new Request('https://example.com/manage', { headers: { cookie: 'session=test-token' } }));
                const body = await response.text();
                expect(body).toContain('Manage Stories');
                expect(body).toContain('Submit New Story');
        });

        it('serves the manage page with trailing slash', async () => {
                const response = await SELF.fetch(new Request('https://example.com/manage/', { headers: { cookie: 'session=test-token' } }));
                const body = await response.text();
                expect(body).toContain('Manage Stories');
                expect(body).toContain('Submit New Story');
        });
});
