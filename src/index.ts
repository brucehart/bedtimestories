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

        if (request.method === 'GET' &&
            (url.pathname === '/submit' || url.pathname === '/submit.html' || url.pathname === '/submit/')) {
            const assetRequest = new Request(request.url.replace(/\/submit\/?$/, '/submit.html'), request);
            return env.ASSETS.fetch(assetRequest);
        }

        if (request.method === 'GET' &&
            (url.pathname === '/manage' || url.pathname === '/manage.html' || url.pathname === '/manage/')) {
            const assetRequest = new Request(request.url.replace(/\/manage\/?$/, '/manage.html'), request);
            return env.ASSETS.fetch(assetRequest);
        }

        if (request.method === 'GET' &&
            (url.pathname === '/edit' || url.pathname === '/edit.html' || url.pathname === '/edit/')) {
            const assetRequest = new Request(request.url.replace(/\/edit\/?$/, '/edit.html'), request);
            return env.ASSETS.fetch(assetRequest);
        }

        if (request.method === 'GET' && url.pathname === '/stories/list') {
            try {
                const page = Number(url.searchParams.get('page') || '1');
                const q = url.searchParams.get('q');
                const limit = 10;
                const offset = (page - 1) * limit;
                let stmt: D1PreparedStatement;
                let countStmt: D1PreparedStatement;
                if (q) {
                    const like = `%${q}%`;
                    stmt = env.DB.prepare(
                        'SELECT * FROM stories WHERE title LIKE ?1 OR content LIKE ?1 ORDER BY date DESC LIMIT ?2 OFFSET ?3'
                    ).bind(like, limit, offset);
                    countStmt = env.DB.prepare(
                        'SELECT COUNT(*) as count FROM stories WHERE title LIKE ?1 OR content LIKE ?1'
                    ).bind(like);
                } else {
                    stmt = env.DB.prepare(
                        'SELECT * FROM stories ORDER BY date DESC LIMIT ?1 OFFSET ?2'
                    ).bind(limit, offset);
                    countStmt = env.DB.prepare('SELECT COUNT(*) as count FROM stories');
                }
                const { results } = await stmt.all<Story>();
                const count = (await countStmt.first<{ count: number }>())?.count || 0;
                return Response.json({ stories: results, total: count });
            } catch {
                return new Response('Internal Error', { status: 500 });
            }
        }

        if (request.method === 'GET' && url.pathname === '/stories') {
            try {
                const stmt = env.DB.prepare('SELECT * FROM stories ORDER BY date DESC LIMIT 1');
                const story = await stmt.first<Story>();
                if (!story) {
                    return new Response('Not Found', { status: 404 });
                }
                return Response.json(story);
            } catch {
                return new Response('Internal Error', { status: 500 });
            }
        }

        if (request.method === 'GET' && url.pathname.startsWith('/stories/')) {
            const parts = url.pathname.split('/');
            const id = Number(parts[2]);
            if (!Number.isInteger(id)) {
                return new Response('Invalid story id', { status: 400 });
            }

            // /stories/:id/next or /stories/:id/prev
            if (parts.length === 4 && (parts[3] === 'next' || parts[3] === 'prev')) {
                try {
                    const order = parts[3] === 'next' ? 'DESC' : 'ASC';
                    const cmp = parts[3] === 'next' ? '<' : '>';
                    const stmt = env.DB.prepare(
                        `SELECT * FROM stories WHERE date ${cmp} (SELECT date FROM stories WHERE id = ?1) ` +
                        `ORDER BY date ${order} LIMIT 1`
                    ).bind(id);
                    const story = await stmt.first<Story>();
                    if (!story) {
                        return new Response('Not Found', { status: 404 });
                    }
                    return Response.json(story);
                } catch {
                    return new Response('Internal Error', { status: 500 });
                }
            }

            try {
                const stmt = env.DB.prepare('SELECT * FROM stories WHERE id = ?1').bind(id);
                const story = await stmt.first<Story>();
                if (!story) {
                    return new Response('Not Found', { status: 404 });
                }
                return Response.json(story);
            } catch {
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

        if (request.method === 'PUT' && url.pathname.startsWith('/stories/')) {
            const [, , idStr] = url.pathname.split('/');
            const id = Number(idStr);
            if (!Number.isInteger(id)) {
                return new Response('Invalid story id', { status: 400 });
            }
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
            let imageKey: string | undefined;
            try {
                const old = await env.DB.prepare('SELECT image_url FROM stories WHERE id = ?1').bind(id).first<{ image_url: string | null }>();
                if (imageFile instanceof File) {
                    const arrayBuffer = await imageFile.arrayBuffer();
                    const parts = imageFile.name.split('.');
                    const ext = parts.length > 1 ? '.' + parts.pop() : '';
                    imageKey = crypto.randomUUID() + ext;
                    await env.IMAGES.put(imageKey, arrayBuffer);
                    if (old?.image_url) await env.IMAGES.delete(old.image_url);
                }
                const stmt = env.DB.prepare(
                    'UPDATE stories SET title = ?1, content = ?2, updated = datetime(\'now\')' + (imageKey !== undefined ? ', image_url = ?3' : '') + ' WHERE id = ?' + (imageKey !== undefined ? '4' : '3')
                );
                if (imageKey !== undefined) {
                    await stmt.bind(title, contentHtml, imageKey, id).run();
                } else {
                    await stmt.bind(title, contentHtml, id).run();
                }
                return new Response('OK');
            } catch {
                return new Response('Internal Error', { status: 500 });
            }
        }

        if (request.method === 'DELETE' && url.pathname.startsWith('/stories/')) {
            const [, , idStr] = url.pathname.split('/');
            const id = Number(idStr);
            if (!Number.isInteger(id)) {
                return new Response('Invalid story id', { status: 400 });
            }
            try {
                const story = await env.DB.prepare('SELECT image_url FROM stories WHERE id = ?1').bind(id).first<{ image_url: string | null }>();
                await env.DB.prepare('DELETE FROM stories WHERE id = ?1').bind(id).run();
                if (story?.image_url) await env.IMAGES.delete(story.image_url);
                return new Response('OK');
            } catch {
                return new Response('Internal Error', { status: 500 });
            }
        }

        return new Response('Not Found', { status: 404 });
    },
} satisfies ExportedHandler<Env>;
