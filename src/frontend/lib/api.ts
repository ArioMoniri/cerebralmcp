/**
 * API helper — bypasses Next.js dev proxy (which has ~30s timeout).
 * The backend's Cerebral-scrape + Claude Opus summarization can take 60-120s,
 * so we call it directly. CORS is enabled server-side.
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.hostname}:8000` : 'http://localhost:8000');

export const WS_BASE =
  process.env.NEXT_PUBLIC_WS_URL ||
  (typeof window !== 'undefined'
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}:8000`
    : 'ws://localhost:8000');

/**
 * fetch wrapper with long timeout (5 min) for slow backend calls.
 */
export async function apiFetch(path: string, init?: RequestInit, timeoutMs = 300_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${API_BASE}${path}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse an error response safely — handles plain-text 500s.
 */
export async function parseError(res: Response): Promise<string> {
  let detail = `Server error (${res.status})`;
  try {
    const err = await res.json();
    detail = err.detail || err.message || detail;
  } catch {
    try {
      const text = await res.text();
      if (text) detail = text.slice(0, 300);
    } catch {}
  }
  return detail;
}
