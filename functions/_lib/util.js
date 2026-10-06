// 批注后端的小工具。Cloudflare Pages Functions（仓库根目录的 functions/ 会被自动识别）。
export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
export const fail = (msg, status = 400) => json({ error: msg }, status);

export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 去掉控制字符、统一换行、截断；内容之后只会当纯文本显示
export function cleanText(s, max) {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, max);
}

// 不允许放链接 / 网址 / 常见域名后缀
export const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(com|cn|net|org|io|top|xyz|cc|me|wiki|club|vip|ru|info|site|online|shop|app|dev|co)\b)/i;

// 只允许对文章页批注：/blog/<slug>/
export const validPage = (p) => typeof p === 'string' && /^\/blog\/[^\/?#\s]{1,100}\/$/.test(p);

// 只接受同源请求
export function sameOrigin(request) {
  const o = request.headers.get('origin');
  if (!o) return true;
  try { return new URL(o).host === new URL(request.url).host; } catch { return false; }
}
