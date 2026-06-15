import { AuthInfo, Env } from './types';
import { bearerToken, randomToken, sha256Hex, timingSafeEqualString } from './security';
import { STORY_AGENT_RUNNER } from './storyAgentRunner';

const DEFAULT_SPRITES_API_BASE = 'https://api.sprites.dev';
const DEFAULT_SPRITE_NAME = 'bedtime-stories';
const DEFAULT_SPRITE_WORKDIR = '/home/sprite/bedtimestories/main';

// Cloudflare's Browser Integrity Check blocks the default curl/urllib
// User-Agent with Error 1010 (browser_signature_banned). The Sprite runner and
// its launcher must present a normal browser User-Agent when calling the Worker.
const SPRITE_RUNNER_USER_AGENT =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MAX_AGENT_PROMPT_LENGTH = 4000;
const MAX_AGENT_MESSAGE_LENGTH = 2000;
const MAX_AGENT_REF_IMAGES = 3;
const MAX_AGENT_REF_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_AGENT_EVENT_MESSAGE_LENGTH = 8000;
const MAX_AGENT_ERROR_LENGTH = 2000;
const MAX_AGENT_TITLE_LENGTH = 200;
const MAX_SPRITE_ERROR_SNIPPET_BYTES = 500;

const AGENT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const JOB_ID_RE = /^[A-Za-z0-9_-]{16,80}$/;
const JOB_STATUS = new Set(['queued', 'starting', 'running', 'complete', 'failed', 'canceled']);
const TERMINAL_STATUS = new Set(['complete', 'failed', 'canceled']);

interface AgentJobRow {
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
    created: string | null;
    updated: string | null;
    started: string | null;
    completed: string | null;
    callback_token_hash: string;
}

interface AgentRefRow {
    id: number;
    job_id: string;
    r2_key: string;
    filename: string;
    content_type: string;
}

interface AgentEventRow {
    id: number;
    event_type: string;
    message: string;
    metadata: string | null;
    created: string | null;
}

interface AgentMessageRow {
    id: number;
    author_email: string;
    content: string;
    created: string | null;
}

type AgentStatus = 'queued' | 'starting' | 'running' | 'complete' | 'failed' | 'canceled';

function jsonResponse(value: unknown, init?: ResponseInit): Response {
    const headers = new Headers(init?.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('Cache-Control', 'no-store');
    headers.set('Referrer-Policy', 'no-referrer');
    return Response.json(value, { ...init, headers });
}

function textResponse(value: string, init?: ResponseInit): Response {
    const headers = new Headers(init?.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('Referrer-Policy', 'no-referrer');
    return new Response(value, { ...init, headers });
}

async function readResponseSnippet(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (total < maxBytes) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;
            const remaining = maxBytes - total;
            const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
            chunks.push(chunk);
            total += chunk.byteLength;
            if (value.byteLength > remaining) break;
        }
    } finally {
        await reader.cancel().catch(() => undefined);
    }
    if (total === 0) return '';
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes).trim();
}

function cleanUpstreamErrorSnippet(value: string): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    if (/<\s*(!doctype|html|head|body)\b/i.test(normalized)) return '';
    return normalized.slice(0, MAX_SPRITE_ERROR_SNIPPET_BYTES);
}

async function spriteLaunchError(response: Response): Promise<string> {
    const statusText = response.statusText ? ` ${response.statusText}` : '';
    const snippet = cleanUpstreamErrorSnippet(
        await readResponseSnippet(response, MAX_SPRITE_ERROR_SNIPPET_BYTES)
    );
    const message = `Sprite launch failed (${response.status}${statusText}).`;
    return snippet
        ? `${message} ${snippet}`
        : `${message} Check SPRITES_API_TOKEN, STORY_AGENT_SPRITE_NAME, and Sprites access.`;
}

function parseAllowedEmails(env: Env): Set<string> {
    return new Set(
        (env.STORY_AGENT_ALLOWED_EMAILS || env.AGENT_ALLOWED_EMAILS || '')
            .split(',')
            .map(email => email.trim().toLowerCase())
            .filter(Boolean)
    );
}

function agentAuthError(auth: AuthInfo, env: Env): Response | null {
    if (auth.role !== 'editor' || !auth.email) {
        return new Response('Forbidden', { status: 403 });
    }
    const allowed = parseAllowedEmails(env);
    if (allowed.size === 0) {
        return new Response('Story agent allowlist not configured', { status: 503 });
    }
    if (!allowed.has(auth.email.toLowerCase())) {
        return new Response('Forbidden', { status: 403 });
    }
    return null;
}

function validateJobId(jobId: string): boolean {
    return JOB_ID_RE.test(jobId);
}

function publicJob(row: AgentJobRow) {
    return {
        id: row.id,
        requested_by: row.requested_by,
        prompt: row.prompt,
        target_date: row.target_date,
        status: row.status,
        sprite_name: row.sprite_name,
        story_id: row.story_id,
        title: row.title,
        error: row.error,
        review_url: row.story_id ? `/?id=${row.story_id}` : null,
        created: row.created,
        updated: row.updated,
        started: row.started,
        completed: row.completed
    };
}

function validateDate(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        throw new Error('Invalid date');
    }
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error('Invalid date');
    }
    return trimmed;
}

function uploadExtension(contentType: string): string {
    if (contentType === 'image/png') return '.png';
    if (contentType === 'image/webp') return '.webp';
    return '.jpg';
}

async function getAuthorizedJob(env: Env, auth: AuthInfo, jobId: string): Promise<AgentJobRow | Response> {
    if (!validateJobId(jobId)) return new Response('Invalid job id', { status: 400 });
    const row = await env.DB.prepare('SELECT * FROM story_agent_jobs WHERE id = ?1')
        .bind(jobId)
        .first<AgentJobRow>();
    if (!row) return new Response('Not Found', { status: 404 });
    if (row.requested_by.toLowerCase() !== auth.email.toLowerCase()) {
        return new Response('Forbidden', { status: 403 });
    }
    return row;
}

async function getJobForCallback(env: Env, request: Request, jobId: string): Promise<AgentJobRow | Response> {
    if (!validateJobId(jobId)) return new Response('Invalid job id', { status: 400 });
    const token = bearerToken(request);
    if (!token) return new Response('Unauthorized', { status: 401 });
    const row = await env.DB.prepare('SELECT * FROM story_agent_jobs WHERE id = ?1')
        .bind(jobId)
        .first<AgentJobRow>();
    if (!row) return new Response('Not Found', { status: 404 });
    const providedHash = await sha256Hex(token);
    if (!timingSafeEqualString(providedHash, row.callback_token_hash)) {
        return new Response('Unauthorized', { status: 401 });
    }
    return row;
}

async function appendAgentEvent(
    env: Env,
    jobId: string,
    eventType: string,
    message: string,
    metadata?: unknown
) {
    const safeEventType = sanitizeEventType(eventType);
    const safeMessage = message.slice(0, MAX_AGENT_EVENT_MESSAGE_LENGTH);
    const metadataJson = metadata === undefined ? null : JSON.stringify(metadata).slice(0, 12000);
    await env.DB.prepare(
        'INSERT INTO story_agent_events (job_id, event_type, message, metadata, created) VALUES (?1, ?2, ?3, ?4, datetime(\'now\'))'
    )
        .bind(jobId, safeEventType, safeMessage, metadataJson)
        .run();
}

function sanitizeEventType(value: string): string {
    const safe = value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    return safe || 'log';
}

function spriteConfig(env: Env) {
    return {
        apiBase: (env.STORY_AGENT_SPRITES_API_BASE || DEFAULT_SPRITES_API_BASE).replace(/\/+$/, ''),
        token: env.SPRITES_API_TOKEN || env.SPRITE_API_TOKEN || '',
        spriteName: env.STORY_AGENT_SPRITE_NAME || DEFAULT_SPRITE_NAME,
        workdir: env.STORY_AGENT_SPRITE_WORKDIR || DEFAULT_SPRITE_WORKDIR
    };
}

async function updateJobStatus(
    env: Env,
    jobId: string,
    status: AgentStatus,
    fields?: { storyId?: number | null; title?: string | null; error?: string | null; sessionId?: string | null }
) {
    const setParts = ['status = ?1', "updated = datetime('now')"];
    const values: (string | number | null)[] = [status];
    if (status === 'running') setParts.push("started = COALESCE(started, datetime('now'))");
    if (TERMINAL_STATUS.has(status)) setParts.push("completed = COALESCE(completed, datetime('now'))");
    if (fields?.storyId !== undefined) {
        values.push(fields.storyId);
        setParts.push(`story_id = ?${values.length}`);
    }
    if (fields?.title !== undefined) {
        values.push(fields.title ? fields.title.slice(0, MAX_AGENT_TITLE_LENGTH) : null);
        setParts.push(`title = ?${values.length}`);
    }
    if (fields?.error !== undefined) {
        values.push(fields.error ? fields.error.slice(0, MAX_AGENT_ERROR_LENGTH) : null);
        setParts.push(`error = ?${values.length}`);
    }
    if (fields?.sessionId !== undefined) {
        values.push(fields.sessionId);
        setParts.push(`sprite_session_id = ?${values.length}`);
    }
    values.push(jobId);
    await env.DB.prepare(`UPDATE story_agent_jobs SET ${setParts.join(', ')} WHERE id = ?${values.length}`)
        .bind(...values)
        .run();
}

async function launchSpriteJob(env: Env, origin: string, jobId: string, callbackToken: string) {
    const config = spriteConfig(env);
    if (!config.token) {
        throw new Error('SPRITES_API_TOKEN is not configured');
    }

    await updateJobStatus(env, jobId, 'starting');
    await appendAgentEvent(env, jobId, 'status', `Starting Sprite ${config.spriteName}.`);

    const runnerPath = `/tmp/story-agent-${jobId}.py`;
    const envPath = `/tmp/story-agent-${jobId}.env`;
    const logPath = `/tmp/story-agent-${jobId}.log`;
    const jobUrl = `${origin}/api/agent/jobs/${encodeURIComponent(jobId)}`;
    const taskName = spriteTaskName(jobId);
    const runnerEnvLines = [
        `export STORY_AGENT_JOB_ID=${quoteShell(jobId)}`,
        `export STORY_AGENT_TOKEN=${quoteShell(callbackToken)}`,
        `export STORY_AGENT_BASE_URL=${quoteShell(origin)}`,
        `export STORY_AGENT_WORKDIR=${quoteShell(config.workdir)}`,
        `export STORY_AGENT_TASK_NAME=${quoteShell(taskName)}`,
        'export PYTHONUNBUFFERED=1'
    ];
    const writeEnvCommand = `umask 077 && printf '%s\\n' ${runnerEnvLines.map(quoteShell).join(' ')} > "$envfile"`;
    // Acquire the Sprite task hold from the launcher itself, before the exec
    // session disconnects. A POST /exec session reaps its process group shortly
    // after the foreground command returns, so the hold has to exist before then
    // to bridge the gap until the runner's own heartbeat takes over.
    const holdTaskCommand =
        `curl -fsS --unix-socket /.sprite/api.sock -X PUT ` +
        `-H ${quoteShell('Content-Type: application/json')} ` +
        `${quoteShell(`http://sprite/v1/tasks/${taskName}`)} ` +
        `-d ${quoteShell(JSON.stringify({ expire: '5m' }))} >> "$logfile" 2>&1`;
    const runScript = [
        `. ${quoteShell(envPath)}`,
        `rm -f ${quoteShell(envPath)}`,
        `exec /home/sprite/scripts/.venv/bin/python ${quoteShell(runnerPath)}`
    ].join(' && ');
    const shell = [
        `runner=${quoteShell(runnerPath)}`,
        `envfile=${quoteShell(envPath)}`,
        `logfile=${quoteShell(logPath)}`,
        ': > "$logfile"',
        `printf '%s\\n' ${quoteShell('launcher: downloading runner')} >> "$logfile"`,
        `curl -fsS -A ${quoteShell(SPRITE_RUNNER_USER_AGENT)} -H ${quoteShell(`Authorization: Bearer ${callbackToken}`)} ${quoteShell(`${jobUrl}/runner.py`)} -o "$runner" >> "$logfile" 2>&1`,
        'chmod 700 "$runner"',
        writeEnvCommand,
        `printf '%s\\n' ${quoteShell('launcher: acquiring sprite task hold')} >> "$logfile"`,
        holdTaskCommand,
        `printf '%s\\n' ${quoteShell('launcher: starting runner')} >> "$logfile"`,
        // setsid detaches the runner into its own session/process group so it is
        // not killed when this exec session's process group is reaped on
        // disconnect. nohup ignores the SIGHUP that disconnect would deliver.
        // The subshell keeps the trailing `&` from breaking the `&&` chain.
        `( setsid nohup bash -lc ${quoteShell(runScript)} < /dev/null >> "$logfile" 2>&1 & )`,
        `printf '%s\\n' ${quoteShell('launcher: runner launch returned')} >> "$logfile"`
    ].join(' && ');

    const url = new URL(`${config.apiBase}/v1/sprites/${encodeURIComponent(config.spriteName)}/exec`);
    url.searchParams.append('cmd', 'bash');
    url.searchParams.append('cmd', '-lc');
    url.searchParams.append('cmd', shell);
    url.searchParams.set('dir', config.workdir);

    const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.token}`,
            'User-Agent': SPRITE_RUNNER_USER_AGENT
        }
    });
    if (!response.ok) {
        throw new Error(await spriteLaunchError(response));
    }
    await appendAgentEvent(env, jobId, 'status', 'Sprite runner launch command accepted.');
}

async function cancelSpriteJob(env: Env, jobId: string) {
    const config = spriteConfig(env);
    if (!config.token) return;
    const taskName = spriteTaskName(jobId);
    const url = new URL(`${config.apiBase}/v1/sprites/${encodeURIComponent(config.spriteName)}/exec`);
    url.searchParams.append('cmd', 'bash');
    url.searchParams.append('cmd', '-lc');
    url.searchParams.append(
        'cmd',
        [
            `pkill -TERM -f ${quoteShell(`story-agent-${jobId}.py`)} || true`,
            `curl -fsS --unix-socket /.sprite/api.sock -X DELETE ${quoteShell(`http://sprite/v1/tasks/${taskName}`)} >/dev/null 2>&1 || true`
        ].join('; ')
    );
    url.searchParams.set('dir', config.workdir);
    await fetch(url.toString(), {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.token}`,
            'User-Agent': SPRITE_RUNNER_USER_AGENT
        }
    });
}

function quoteShell(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function spriteTaskName(jobId: string): string {
    return `story-agent-${jobId}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'story-agent';
}

function formFiles(data: FormData): File[] {
    const files: File[] = [];
    for (const name of ['ref_images', 'ref_image', 'refs']) {
        for (const value of data.getAll(name)) {
            if (value instanceof File && value.size > 0) files.push(value);
        }
    }
    return files;
}

export async function createAgentJob(request: Request, env: Env, ctx: ExecutionContext, auth: AuthInfo) {
    const authError = agentAuthError(auth, env);
    if (authError) return authError;
    if (!request.headers.get('content-type')?.includes('multipart/form-data')) {
        return new Response('Expected multipart/form-data', { status: 400 });
    }
    if (!spriteConfig(env).token) {
        return new Response('SPRITES_API_TOKEN is not configured', { status: 503 });
    }

    const data = await request.formData();
    const promptValue = data.get('prompt');
    const dateValue = data.get('date');
    if (typeof promptValue !== 'string') {
        return new Response('Missing prompt', { status: 400 });
    }
    const prompt = promptValue.trim();
    if (!prompt) return new Response('Missing prompt', { status: 400 });
    if (prompt.length > MAX_AGENT_PROMPT_LENGTH) return new Response('Prompt too long', { status: 400 });

    let targetDate: string | null = null;
    try {
        targetDate = typeof dateValue === 'string' ? validateDate(dateValue) : null;
    } catch {
        return new Response('Invalid date', { status: 400 });
    }

    const files = formFiles(data);
    if (files.length > MAX_AGENT_REF_IMAGES) {
        return new Response('Too many reference images', { status: 400 });
    }
    for (const file of files) {
        const type = file.type.toLowerCase();
        if (!AGENT_IMAGE_TYPES.has(type)) return new Response('Unsupported Media Type', { status: 415 });
        if (file.size > MAX_AGENT_REF_IMAGE_BYTES) return new Response('Payload Too Large', { status: 413 });
    }

    const jobId = randomToken(18);
    const callbackToken = randomToken(32);
    const callbackTokenHash = await sha256Hex(callbackToken);
    const config = spriteConfig(env);
    await env.DB.prepare(
        'INSERT INTO story_agent_jobs (id, requested_by, prompt, target_date, status, sprite_name, callback_token_hash, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime(\'now\'), datetime(\'now\'))'
    )
        .bind(jobId, auth.email, prompt, targetDate, 'queued', config.spriteName, callbackTokenHash)
        .run();

    let refIndex = 0;
    for (const file of files) {
        refIndex++;
        const key = `agent-jobs/${jobId}/${crypto.randomUUID()}${uploadExtension(file.type.toLowerCase())}`;
        await env.IMAGES.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
        await env.DB.prepare(
            'INSERT INTO story_agent_refs (job_id, r2_key, filename, content_type, created) VALUES (?1, ?2, ?3, ?4, datetime(\'now\'))'
        )
            .bind(jobId, key, file.name || `reference-${refIndex}${uploadExtension(file.type.toLowerCase())}`, file.type)
            .run();
    }

    await appendAgentEvent(env, jobId, 'status', 'Story agent job queued.');
    const origin = new URL(request.url).origin;
    ctx.waitUntil(
        launchSpriteJob(env, origin, jobId, callbackToken).catch(async error => {
            const message = error instanceof Error ? error.message : 'Sprite launch failed';
            await updateJobStatus(env, jobId, 'failed', { error: message });
            await appendAgentEvent(env, jobId, 'failed', message);
        })
    );

    const row = await env.DB.prepare('SELECT * FROM story_agent_jobs WHERE id = ?1')
        .bind(jobId)
        .first<AgentJobRow>();
    return jsonResponse({ job: row ? publicJob(row) : { id: jobId, status: 'queued' } }, { status: 202 });
}

export async function listAgentJobs(_request: Request, env: Env, auth: AuthInfo) {
    const authError = agentAuthError(auth, env);
    if (authError) return authError;
    const { results } = await env.DB.prepare(
        'SELECT * FROM story_agent_jobs WHERE LOWER(requested_by) = LOWER(?1) ORDER BY created DESC LIMIT 10'
    )
        .bind(auth.email)
        .all<AgentJobRow>();
    return jsonResponse({ jobs: results.map(publicJob) });
}

export async function getAgentJob(_request: Request, env: Env, auth: AuthInfo, jobId: string) {
    const authError = agentAuthError(auth, env);
    if (authError) return authError;
    const row = await getAuthorizedJob(env, auth, jobId);
    if (row instanceof Response) return row;
    return jsonResponse({ job: publicJob(row) });
}

export async function getAgentEvents(request: Request, env: Env, auth: AuthInfo, jobId: string, url: URL) {
    const authError = agentAuthError(auth, env);
    if (authError) return authError;
    const row = await getAuthorizedJob(env, auth, jobId);
    if (row instanceof Response) return row;
    const lastHeader = request.headers.get('Last-Event-ID');
    const after = Number(url.searchParams.get('after') || lastHeader || '0');
    const safeAfter = Number.isFinite(after) && after > 0 ? Math.floor(after) : 0;
    const { results } = await env.DB.prepare(
        'SELECT id, event_type, message, metadata, created FROM story_agent_events WHERE job_id = ?1 AND id > ?2 ORDER BY id ASC LIMIT 100'
    )
        .bind(jobId, safeAfter)
        .all<AgentEventRow>();
    const chunks = ['retry: 2000\n'];
    if (results.length === 0) {
        chunks.push(': heartbeat\n\n');
    }
    for (const event of results) {
        chunks.push(`id: ${event.id}\n`);
        chunks.push(`event: ${event.event_type}\n`);
        chunks.push(`data: ${JSON.stringify({
            message: event.message,
            metadata: event.metadata ? JSON.parse(event.metadata) : null,
            created: event.created
        })}\n\n`);
    }
    return textResponse(chunks.join(''), {
        headers: {
            'Content-Type': 'text/event-stream',
            'X-Accel-Buffering': 'no'
        }
    });
}

export async function createAgentMessage(request: Request, env: Env, auth: AuthInfo, jobId: string) {
    const authError = agentAuthError(auth, env);
    if (authError) return authError;
    const row = await getAuthorizedJob(env, auth, jobId);
    if (row instanceof Response) return row;
    if (TERMINAL_STATUS.has(row.status)) {
        return new Response('Job is not active', { status: 409 });
    }
    const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const content = typeof payload?.content === 'string' ? payload.content.trim() : '';
    if (!content) return new Response('Missing content', { status: 400 });
    if (content.length > MAX_AGENT_MESSAGE_LENGTH) return new Response('Message too long', { status: 400 });
    const result = await env.DB.prepare(
        'INSERT INTO story_agent_messages (job_id, author_email, content, created) VALUES (?1, ?2, ?3, datetime(\'now\'))'
    )
        .bind(jobId, auth.email, content)
        .run();
    await appendAgentEvent(env, jobId, 'feedback', 'Feedback queued for Codex.');
    return jsonResponse({ id: result.meta.last_row_id });
}

export async function cancelAgentJob(_request: Request, env: Env, ctx: ExecutionContext, auth: AuthInfo, jobId: string) {
    const authError = agentAuthError(auth, env);
    if (authError) return authError;
    const row = await getAuthorizedJob(env, auth, jobId);
    if (row instanceof Response) return row;
    if (!TERMINAL_STATUS.has(row.status)) {
        await updateJobStatus(env, jobId, 'canceled');
        await appendAgentEvent(env, jobId, 'canceled', 'Job canceled from manage page.');
        ctx.waitUntil(cancelSpriteJob(env, jobId).catch(() => undefined));
    }
    return jsonResponse({ ok: true });
}

export async function getRunnerScript(request: Request, env: Env, jobId: string) {
    const row = await getJobForCallback(env, request, jobId);
    if (row instanceof Response) return row;
    return textResponse(STORY_AGENT_RUNNER, {
        headers: {
            'Content-Type': 'text/x-python; charset=utf-8'
        }
    });
}

export async function getAgentBootstrap(request: Request, env: Env, jobId: string) {
    const row = await getJobForCallback(env, request, jobId);
    if (row instanceof Response) return row;
    const { results } = await env.DB.prepare(
        'SELECT id, filename, content_type FROM story_agent_refs WHERE job_id = ?1 ORDER BY id ASC'
    )
        .bind(jobId)
        .all<{ id: number; filename: string; content_type: string }>();
    return jsonResponse({
        id: row.id,
        prompt: row.prompt,
        target_date: row.target_date,
        status: row.status,
        refs: results.map(ref => ({
            id: ref.id,
            filename: ref.filename,
            content_type: ref.content_type,
            url: `/api/agent/jobs/${encodeURIComponent(jobId)}/refs/${ref.id}`
        }))
    });
}

export async function getAgentReference(request: Request, env: Env, jobId: string, refId: number) {
    const row = await getJobForCallback(env, request, jobId);
    if (row instanceof Response) return row;
    const ref = await env.DB.prepare(
        'SELECT id, job_id, r2_key, filename, content_type FROM story_agent_refs WHERE job_id = ?1 AND id = ?2'
    )
        .bind(jobId, refId)
        .first<AgentRefRow>();
    if (!ref) return new Response('Not Found', { status: 404 });
    const object = await env.IMAGES.get(ref.r2_key);
    if (!object) return new Response('Not Found', { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Disposition', `attachment; filename="${ref.filename.replace(/["\r\n]/g, '')}"`);
    return new Response(object.body, { headers });
}

export async function getRunnerMessages(request: Request, env: Env, jobId: string, url: URL) {
    const row = await getJobForCallback(env, request, jobId);
    if (row instanceof Response) return row;
    const after = Number(url.searchParams.get('after') || '0');
    const safeAfter = Number.isFinite(after) && after > 0 ? Math.floor(after) : 0;
    const { results } = await env.DB.prepare(
        'SELECT id, author_email, content, created FROM story_agent_messages WHERE job_id = ?1 AND id > ?2 ORDER BY id ASC LIMIT 25'
    )
        .bind(jobId, safeAfter)
        .all<AgentMessageRow>();
    return jsonResponse({ messages: results });
}

export async function createRunnerEvent(request: Request, env: Env, jobId: string) {
    const row = await getJobForCallback(env, request, jobId);
    if (row instanceof Response) return row;
    const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const eventType = typeof payload?.type === 'string' ? payload.type : 'log';
    const message = typeof payload?.message === 'string' ? payload.message : '';
    const metadata = payload?.metadata;
    if (!message) return new Response('Missing message', { status: 400 });
    await appendAgentEvent(env, jobId, eventType, message, metadata);
    return jsonResponse({ ok: true });
}

export async function updateRunnerJob(request: Request, env: Env, jobId: string) {
    const row = await getJobForCallback(env, request, jobId);
    if (row instanceof Response) return row;
    const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const status = typeof payload?.status === 'string' ? payload.status : '';
    if (!JOB_STATUS.has(status)) return new Response('Invalid status', { status: 400 });
    if (TERMINAL_STATUS.has(row.status)) {
        return jsonResponse({ ok: true, ignored: true, status: row.status });
    }
    const storyId = typeof payload?.story_id === 'number' && Number.isInteger(payload.story_id)
        ? payload.story_id
        : undefined;
    const title = typeof payload?.title === 'string' ? payload.title : undefined;
    const error = typeof payload?.error === 'string' ? payload.error : undefined;
    await updateJobStatus(env, jobId, status as AgentStatus, { storyId, title, error });
    await appendAgentEvent(env, jobId, status, `Job status changed to ${status}.`, {
        story_id: storyId,
        title
    });
    return jsonResponse({ ok: true });
}
