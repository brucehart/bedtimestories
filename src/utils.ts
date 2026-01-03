// Escape HTML special characters
export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[c] as string));
}

// Convert very small subset of markdown to HTML
export function markdownToHtml(md: string): string {
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

export function unescapeHtml(text: string): string {
    return text.replace(/&(amp|lt|gt|quot|#39);/g, entity => ({
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#39;': "'"
    }[entity] as string));
}

export function htmlToPlainText(html: string): string {
    const withLineBreaks = html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>\s*<p>/gi, '\n\n')
        .replace(/<\/h[1-6]>\s*<h[1-6]>/gi, '\n\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/h[1-6]>/gi, '\n\n');
    const stripped = withLineBreaks.replace(/<[^>]+>/g, '');
    return unescapeHtml(stripped).replace(/\n{3,}/g, '\n\n').trim();
}

// Parse cookies from a request header
export function parseCookies(cookieHeader: string | null): Record<string, string> {
    const cookies: Record<string, string> = {};
    if (!cookieHeader) return cookies;
    for (const pair of cookieHeader.split(';')) {
        const [key, ...vals] = pair.trim().split('=');
        cookies[key] = vals.join('=');
    }
    return cookies;
}

// Return the current time shifted to US Eastern timezone as an ISO string
export function easternNowIso(): string {
    const now = new Date();
    // Get the same wall-clock time in America/New_York. Parsing the string gives
    // us a Date object in UTC representing that local time.
    const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const offset = now.getTime() - eastern.getTime();
    // Subtracting the offset yields the timestamp aligned with Eastern time
    return new Date(now.getTime() - offset).toISOString();
}
