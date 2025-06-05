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
