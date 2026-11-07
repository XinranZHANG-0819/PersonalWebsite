// GET /api/me/data   读取最新一份资产数据（需要登录，或 ME_UPLOAD_TOKEN）
// PUT /api/me/data   上传一份新数据（登录后在页面上导入，或用 ME_UPLOAD_TOKEN 自动上传）；保留最近 60 份
import { fail, sameOrigin } from '../../_lib/util.js';
import { configured, hasSession, hasUploadToken, meDb, validateData, privJson } from '../../_lib/me.js';

const MAX_BYTES = 300 * 1024;

export async function onRequestGet({ request, env }) {
  if (!configured(env)) return privJson({ error: 'not configured' }, 503);
  // 登录后的页面，或带 ME_UPLOAD_TOKEN 的每周自动更新任务（先读最新一份，再改写上传）
  if (!(await hasSession(request, env)) && !(await hasUploadToken(request, env))) return privJson({ error: 'login required' }, 401);
  const db = await meDb(env);
  const row = await db.prepare('SELECT id, as_of, data, created_at FROM me_snapshots ORDER BY id DESC LIMIT 1').first();
  if (!row) return privJson({ data: null });
  return privJson({ id: row.id, uploadedAt: row.created_at, data: JSON.parse(row.data) });
}

export async function onRequestPut({ request, env }) {
  if (!configured(env)) return privJson({ error: 'not configured' }, 503);
  const bySession = sameOrigin(request) && (await hasSession(request, env));
  if (!bySession && !(await hasUploadToken(request, env))) return privJson({ error: 'login required' }, 401);
  const text = await request.text();
  if (text.length > MAX_BYTES) return fail('数据太大', 413);
  let d;
  try { d = JSON.parse(text); } catch { return fail('不是合法的 JSON'); }
  const bad = validateData(d);
  if (bad) return fail(bad);
  const db = await meDb(env);
  const row = await db.prepare('INSERT INTO me_snapshots (as_of, data) VALUES (?, ?) RETURNING id').bind(d.asOf, JSON.stringify(d)).first();
  await db.prepare('DELETE FROM me_snapshots WHERE id NOT IN (SELECT id FROM me_snapshots ORDER BY id DESC LIMIT 60)').run();
  return privJson({ ok: true, id: row.id, asOf: d.asOf }, 201);
}
