/**
 * API base URL resolver. Three modes:
 *
 * 1. NEXT_PUBLIC_API_URL set (non-empty) at build time
 *    → use it absolutely (good for separate-host backend deployments)
 *
 * 2. Browser is on localhost
 *    → talk directly to http://localhost:8000 to bypass Next.js dev-proxy's
 *      30s timeout (the patient ingest can take 60-120s)
 *
 * 3. Browser is on any other host (production deploy, Cloudflare tunnel)
 *    → use relative URLs (empty base) so /api/* hits the same Next.js
 *      origin, and Next.js rewrites in next.config.js proxy to the local
 *      backend. Single-host deploy = single tunnel URL to share.
 */
function resolveApiBase(): string {
  const buildTime = process.env.NEXT_PUBLIC_API_URL;
  if (buildTime && buildTime.length > 0) return buildTime;
  if (typeof window === 'undefined') return 'http://localhost:8000';
  const host = window.location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
  if (isLocal) return `${window.location.protocol}//${host}:8000`;
  return ''; // relative — Next.js rewrite handles the proxy
}

function resolveWsBase(): string {
  const buildTime = process.env.NEXT_PUBLIC_WS_URL;
  if (buildTime && buildTime.length > 0) return buildTime;
  if (typeof window === 'undefined') return 'ws://localhost:8000';
  const host = window.location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (isLocal) return `${wsProto}//${host}:8000`;
  return `${wsProto}//${window.location.host}`;
}

export const API_BASE = resolveApiBase();
export const WS_BASE = resolveWsBase();

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
