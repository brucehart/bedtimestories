// Cloudflare Worker used to store and manage short bedtime stories.
import { Env } from './types';
import { fetchHandler } from './routes';
export { signSession, verifySession, SESSION_MAXAGE } from './session';

export default {
    fetch: fetchHandler
} satisfies ExportedHandler<Env>;
