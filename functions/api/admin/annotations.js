// 管理员接口（需要 Cloudflare Access 登录）：查看全部（含已隐藏）、隐藏/显示、回复、删除
import { json, fail, cleanText, sameOrigin } from '../../_lib/util.js';
import { getDb } from '../../_lib/db.js';
import { requireAdmin } from '../../_lib/access.js';

const COLS = 'id, page, exact, body, nickname, status, reply, replied_at, created_at';

async function guard(request, env) {
  const email = await requireAdmin(request, env);
  return email ? null : fail('需要管理员登录', 401);
}

export async function onRequestGet({ request, env }) {
  const denied = await guard(request, env);
  if (denied) return denied;
  const db = await getDb(env);
  const { results } = await db.prepare(`SELECT ${COLS} FROM annotations ORDER BY id DESC LIMIT 500`).all();
  return json({ annotations: results });
}

export async function onRequestPatch({ request, env }) {
  if (!sameOrigin(request)) return fail('forbidden', 403);
  const denied = await guard(request, env);
  if (denied) return denied;
  let d;
  try { d = await request.json(); } catch { return fail('bad json'); }
  if (!Number.isInteger(d.id)) return fail('bad id');
  const db = await getDb(env);
  if (d.status !== undefined) {
    if (!['visible', 'hidden'].includes(d.status)) return fail('bad status');
    await db.prepare('UPDATE annotations SET status = ? WHERE id = ?').bind(d.status, d.id).run();
  }
  if (d.reply !== undefined) {
    const reply = d.reply === null ? '' : cleanText(d.reply, 1000);
    if (reply) await db.prepare(`UPDATE annotations SET reply = ?, replied_at = datetime('now') WHERE id = ?`).bind(reply, d.id).run();
    else await db.prepare('UPDATE annotations SET reply = NULL, replied_at = NULL WHERE id = ?').bind(d.id).run();
  }
  const row = await db.prepare(`SELECT ${COLS} FROM annotations WHERE id = ?`).bind(d.id).first();
  return json({ annotation: row });
}

export async function onRequestDelete({ request, env }) {
  if (!sameOrigin(request)) return fail('forbidden', 403);
  const denied = await guard(request, env);
  if (denied) return denied;
  const id = Number(new URL(request.url).searchParams.get('id'));
  if (!Number.isInteger(id)) return fail('bad id');
  const db = await getDb(env);
  await db.prepare('DELETE FROM annotations WHERE id = ?').bind(id).run();
  return json({ ok: true });
}
