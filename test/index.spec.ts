import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Hello World worker', () => {
        it('responds with Hello World! (unit style)', async () => {
                const request = new IncomingRequest('http://example.com');
                const ctx = createExecutionContext();
                const response = await worker.fetch(request, env, ctx);
                await waitOnExecutionContext(ctx);
                const body = await response.text();
                expect(body).toContain('<h1>Hello World</h1>');
        });

        it('responds with Hello World! (integration style)', async () => {
                const response = await SELF.fetch('https://example.com');
                const body = await response.text();
                expect(body).toContain('<h1>Hello World</h1>');
        });
});
