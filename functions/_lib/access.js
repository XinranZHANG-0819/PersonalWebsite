// 校验 Cloudflare Access 签发的登录凭证（JWT），确认请求来自已登录的管理员。
// 需要的变量：ACCESS_TEAM_DOMAIN（形如 xxx.cloudflareaccess.com）、ACCESS_AUD（应用的 Audience Tag），可选 ADMIN_EMAILS（逗号分隔）。
// 仅本地测试用：把 ACCESS_AUD 设为 "__dev_skip__"，并带请求头 x-dev-admin: 邮箱，即视为已登录；正式环境绝对不要这样设。
const b64urlToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

let jwksCache = { at: 0, keys: null, team: '' };
async function getKeys(team, fetchImpl) {
  if (jwksCache.keys && jwksCache.team === team && Date.now() - jwksCache.at < 10 * 60 * 1000) return jwksCache.keys;
  const r = await fetchImpl(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error('jwks fetch failed');
  const j = await r.json();
  jwksCache = { at: Date.now(), keys: j.keys || [], team };
  return jwksCache.keys;
}

export async function verifyAccessJwt(token, { team, aud, now = Date.now(), fetchImpl = fetch }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = b64urlToJson(parts[0]); payload = b64urlToJson(parts[1]); } catch { return null; }
  if (header.alg !== 'RS256') return null;
  const keys = await getKeys(team, fetchImpl);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) return null;
  const audOk = Array.isArray(payload.aud) ? payload.aud.includes(aud) : payload.aud === aud;
  if (!audOk) return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < now) return null;
  if (payload.iss !== `https://${team}`) return null;
  return payload;
}

/** 返回管理员邮箱；没有登录或不是管理员返回 null */
export async function requireAdmin(request, env) {
  if (env.ACCESS_AUD === '__dev_skip__') return request.headers.get('x-dev-admin') || null;
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const cookie = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get('cookie') || '');
  const token = request.headers.get('cf-access-jwt-assertion') || (cookie && cookie[1]);
  if (!token) return null;
  let payload;
  try { payload = await verifyAccessJwt(token, { team: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD }); } catch { return null; }
  if (!payload || !payload.email) return null;
  const allow = String(env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.includes(String(payload.email).toLowerCase())) return null;
  return payload.email;
}
