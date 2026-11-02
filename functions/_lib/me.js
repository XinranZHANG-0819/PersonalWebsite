// 私人资产页（/me/）的登录与数据存取。
// 需要的变量：ME_PASSWORD（Secret，至少 12 位）。可选：ME_UPLOAD_TOKEN（Secret，至少 24 位，给自动上传数据用）。
// 数据只存在 D1 里，不进仓库；网页本身是空壳，登录后才从这里取数据。
import { json, sha256Hex } from './util.js';

const enc = new TextEncoder();
const COOKIE = 'me_session';
export const SESSION_DAYS = 7;

export const configured = (env) => typeof env.ME_PASSWORD === 'string' && env.ME_PASSWORD.length >= 12;

// 私人数据的响应：不缓存、不收录
export const privJson = (data, status = 200, headers = {}) =>
  json(data, status, { 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer', ...headers });

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

// 会话密钥由口令派生：改口令后，所有旧登录自动失效
const sessionKey = (env) => hmacKey('me-session|' + env.ME_PASSWORD);

// 恒定时间比较：用 HMAC 验签，不直接比字符串
export async function checkSecret(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !given || given.length > 256) return false;
  const key = await hmacKey('me-compare|' + expected.length);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(expected));
  return crypto.subtle.verify('HMAC', key, sig, enc.encode(given));
}

export async function makeSessionCookie(env, now = Date.now()) {
  const exp = Math.floor(now / 1000) + SESSION_DAYS * 86400;
  const sig = await crypto.subtle.sign('HMAC', await sessionKey(env), enc.encode('me:' + exp));
  const token = exp + '.' + b64url(sig);
  return `${COOKIE}=${token}; Path=/api/me; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/api/me; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export async function hasSession(request, env, now = Date.now()) {
  if (!configured(env)) return false;
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)me_session=([0-9]+)\.([A-Za-z0-9_-]+)/);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!Number.isFinite(exp) || exp * 1000 < now) return false;
  try {
    return await crypto.subtle.verify('HMAC', await sessionKey(env), fromB64url(m[2]), enc.encode('me:' + exp));
  } catch { return false; }
}

// 自动上传：Authorization: Bearer <ME_UPLOAD_TOKEN>
export async function hasUploadToken(request, env) {
  const t = env.ME_UPLOAD_TOKEN;
  if (typeof t !== 'string' || t.length < 24) return false;
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(\S+)$/);
  return !!m && (await checkSecret(m[1], t));
}

let ready = null;
export function meDb(env) {
  if (!env.DB) throw new Error('D1 binding "DB" is missing');
  if (!ready) {
    ready = env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS me_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        as_of TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS me_logins (
        ip_hash TEXT NOT NULL,
        ok INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_me_logins ON me_logins(ip_hash, created_at)'),
    ]).catch((e) => { ready = null; throw e; });
  }
  return ready.then(() => env.DB);
}

export async function ipHash(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || '';
  return (await sha256Hex((env.IP_SALT || '') + '|me|' + ip)).slice(0, 32);
}

// 上传数据的基本校验：结构、大小、日期格式
export function validateData(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return '数据不是对象';
  if (d.version !== 1) return '不支持的数据版本（应为 version: 1）';
  if (typeof d.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.asOf)) return 'asOf 应为 YYYY-MM-DD';
  if (!d.accounts || typeof d.accounts !== 'object') return '缺少 accounts';
  if (!Array.isArray(d.holdings)) return '缺少 holdings';
  if (!Array.isArray(d.flows) || !d.flows.every((f) => /^\d{4}-\d{2}-\d{2}$/.test(f?.date) && Number.isFinite(f?.amount))) return 'flows 格式不对';
  if (!Array.isArray(d.monthly) || !d.monthly.every((r) => Array.isArray(r) && /^\d{4}-\d{2}$/.test(r[0]) && Number.isFinite(r[1]))) return 'monthly 格式不对';
  return null;
}
