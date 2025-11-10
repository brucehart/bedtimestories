// Cloudflare Worker used to store and manage short bedtime stories.
import { Env } from './types';
import { fetchHandler } from './routes';
export { signSession, verifySession, SESSION_MAXAGE } from './session';

const UPDATE_CACHE_BASE = 'https://bedtimestories';

function buildUpdateCacheRequest(env: Env): Request {
    const daysOverride =
        env.CACHE_REFRESH_DAYS && Number.isFinite(Number(env.CACHE_REFRESH_DAYS))
            ? Math.max(1, Math.floor(Number(env.CACHE_REFRESH_DAYS)))
            : undefined;
    const url = new URL(UPDATE_CACHE_BASE);
    url.pathname = '/update-cache';
    if (daysOverride !== undefined) {
        url.searchParams.set('days', daysOverride.toString());
    }
    const headers = new Headers();
    if (env.CACHE_REFRESH_TOKEN) {
        headers.set('Authorization', `Bearer ${env.CACHE_REFRESH_TOKEN}`);
    }
    return new Request(url, { method: 'GET', headers });
}

export default {
    async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
        ctx.waitUntil(
            (async () => {
                try {
                    const req = buildUpdateCacheRequest(env);
                    await fetchHandler(req, env, ctx);
                } catch (err) {
                    console.error('scheduled update-cache failed', err);
                }
            })()
        );
    },

    fetch: fetchHandler
} satisfies ExportedHandler<Env>;
