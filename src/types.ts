export interface Story {
    id: number;
    title: string;
    content: string;
    date: string;
    image_url: string | null;
    video_url: string | null;
    created: string | null;
    updated: string | null;
}

export interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    IMAGES: R2Bucket;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    OAUTH_CALLBACK_URL: string;
    SESSION_HMAC_KEY: string;
    PUBLIC_VIEW?: string;
    CACHE_REFRESH_TOKEN?: string;
    CACHE_REFRESH_DAYS?: string;
    STORY_API_TOKEN?: string;
}

export interface AuthInfo {
    email: string;
    role: 'reader' | 'editor';
}

export interface Route {
    method: string;
    pattern: RegExp;
    handler: (
        req: Request,
        env: Env,
        ctx: ExecutionContext,
        match: RegExpMatchArray,
        url: URL,
        auth: AuthInfo
    ) => Promise<Response> | Response;
}
