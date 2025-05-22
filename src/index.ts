/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

interface Story {
    id: number;
    title: string;
    content: string;
    date: string;
    image_url: string | null;
    created: string | null;
    updated: string | null;
}

interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    IMAGES: R2Bucket;
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[c] as string));
}

function markdownToHtml(md: string): string {
    return md
        .split(/\n\n+/)
        .map(block => {
            const line = block.trim();
            if (line.startsWith('### ')) return `<h3>${escapeHtml(line.slice(4))}</h3>`;
            if (line.startsWith('## ')) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
            if (line.startsWith('# ')) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
            const html = escapeHtml(line)
                .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                .replace(/\*(.+?)\*/g, '<em>$1</em>')
                .replace(/\n/g, '<br/>');
            return `<p>${html}</p>`;
        })
        .join('');
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
            return env.ASSETS.fetch(request);
        }

        if (request.method === 'GET' && (url.pathname === '/submit' || url.pathname === '/submit.html')) {
            const assetRequest = new Request(request.url.replace(/\/submit$/, '/submit.html'), request);
            return env.ASSETS.fetch(assetRequest);
        }

        if (request.method === 'GET' && url.pathname === '/stories') {
            try {
                const stmt = env.DB.prepare('SELECT * FROM stories ORDER BY date DESC LIMIT 1');
                const story = await stmt.first<Story>();
                if (!story) {
                    return new Response('Not Found', { status: 404 });
                }
                return Response.json(story);
            } catch (err) {
                return new Response('Internal Error', { status: 500 });
            }
        }

        if (request.method === 'GET' && url.pathname.startsWith('/stories/')) {
            const [, , idStr] = url.pathname.split('/');
            const id = Number(idStr);
            if (!Number.isInteger(id)) {
                return new Response('Invalid story id', { status: 400 });
            }
            try {
                const stmt = env.DB.prepare('SELECT * FROM stories WHERE id = ?1').bind(id);
                const story = await stmt.first<Story>();
                if (!story) {
                    return new Response('Not Found', { status: 404 });
                }
                return Response.json(story);
            } catch (err) {
                return new Response('Internal Error', { status: 500 });
            }
        }

        if (request.method === 'POST' && url.pathname === '/stories') {
            if (!request.headers.get('content-type')?.includes('multipart/form-data')) {
                return new Response('Expected multipart/form-data', { status: 400 });
            }
            const data = await request.formData();
            const title = data.get('title');
            const contentMd = data.get('content');
            const imageFile = data.get('image');

            if (typeof title !== 'string' || typeof contentMd !== 'string') {
                return new Response('Invalid form data', { status: 400 });
            }

            const contentHtml = markdownToHtml(contentMd);

            let imageKey: string | null = null;
            if (imageFile instanceof File) {
                const arrayBuffer = await imageFile.arrayBuffer();
                const parts = imageFile.name.split('.');
                const ext = parts.length > 1 ? '.' + parts.pop() : '';
                imageKey = crypto.randomUUID() + ext;
                await env.IMAGES.put(imageKey, arrayBuffer);
            }

            try {
                const stmt = env.DB.prepare(
                    'INSERT INTO stories (title, content, date, image_url, created, updated) VALUES (?1, ?2, ?3, ?4, datetime(\'now\'), datetime(\'now\'))'
                ).bind(title, contentHtml, new Date().toISOString(), imageKey);
                const result = await stmt.run();
                const id = result.meta.last_row_id;
                return Response.json({ id });
            } catch (err) {
                return new Response('Internal Error', { status: 500 });
            }
        }

        return new Response('Not Found', { status: 404 });
    },
} satisfies ExportedHandler<Env>;
