// POST   /api/me/login   用口令登录私人资产页，成功后发一个 7 天有效、只发给 /api/me 的 HttpOnly 会话 cookie
// DELETE /api/me/login   退出
import { fail, sameOrigin } from '../../_lib/util.js';
import { configured, checkSecret, makeSessionCookie, clearCookie, meDb, ipHash, privJson } from '../../_lib/me.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return fail('forbidden', 403);
  if (!configured(env)) return privJson({ error: '私人页还没有设置口令（ME_PASSWORD）' }, 503);
  let d;
  try { d = await request.json(); } catch { return fail('bad json'); }

  const db = await meDb(env);
  const ih = await ipHash(request, env);
  // 限速：同一访客 15 分钟内输错 5 次、或所有人 15 分钟内一共输错 50 次，就暂停登录
  const r = await db.prepare(`SELECT
      SUM(ip_hash = ?1 AND ok = 0) AS mine,
      SUM(ok = 0) AS allf
    FROM me_logins WHERE created_at > datetime('now','-15 minutes')`).bind(ih).first();
  if ((r?.mine || 0) >= 5 || (r?.allf || 0) >= 50) return privJson({ error: '尝试次数太多，请 15 分钟后再试' }, 429);

  const ok = await checkSecret(d?.password, env.ME_PASSWORD);
  await db.prepare('INSERT INTO me_logins (ip_hash, ok) VALUES (?, ?)').bind(ih, ok ? 1 : 0).run();
  await db.prepare(`DELETE FROM me_logins WHERE created_at < datetime('now','-2 days')`).run();
  if (!ok) { await sleep(400); return privJson({ error: '口令不对' }, 401); }
  return privJson({ ok: true }, 200, { 'set-cookie': await makeSessionCookie(env) });
}

export async function onRequestDelete({ request }) {
  if (!sameOrigin(request)) return fail('forbidden', 403);
  return privJson({ ok: true }, 200, { 'set-cookie': clearCookie() });
}
