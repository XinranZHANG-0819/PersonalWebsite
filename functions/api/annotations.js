// GET  /api/annotations?page=/blog/xxx/   读取某篇文章的（可见）批注
// POST /api/annotations                    读者提交批注
import { json, fail, sha256Hex, cleanText, LINK_RE, validPage, sameOrigin } from '../_lib/util.js';
import { getDb } from '../_lib/db.js';
import { verifyTurnstile } from '../_lib/turnstile.js';

const PUBLIC_COLS = 'id, exact, prefix, suffix, start, body, nickname, reply, replied_at, created_at';

export async function onRequestGet({ request, env }) {
  const page = new URL(request.url).searchParams.get('page');
  if (!validPage(page)) return fail('bad page');
  const db = await getDb(env);
  const { results } = await db
    .prepare(`SELECT ${PUBLIC_COLS} FROM annotations WHERE page = ? AND status = 'visible' ORDER BY start, id LIMIT 500`)
    .bind(page)
    .all();
  return json({ annotations: results });
}

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return fail('forbidden', 403);
  let d;
  try { d = await request.json(); } catch { return fail('bad json'); }
  if (d.website) return json({ ok: true }, 201); // 蜜罐：机器人会填这个字段，假装成功就行
  if (!validPage(d.page)) return fail('bad page');

  const exact = cleanText(d.exact, 400);
  const body = cleanText(d.body, 1000);
  const nickname = cleanText(d.nickname, 24).replace(/\n/g, ' ');
  const prefix = cleanText(d.prefix, 40);
  const suffix = cleanText(d.suffix, 40);
  const start = Number.isInteger(d.start) && d.start >= 0 && d.start < 1e7 ? d.start : null;
  if (!exact) return fail('请先选中要批注的文字');
  if (!body) return fail('批注内容不能为空');
  if (LINK_RE.test(body) || LINK_RE.test(nickname)) return fail('批注里不能放链接或网址');

  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!(await verifyTurnstile(d.token, env.TURNSTILE_SECRET, ip))) return fail('人机验证没有通过，请重试', 403);

  const ipHash = (await sha256Hex((env.IP_SALT || '') + '|' + ip)).slice(0, 32);
  const db = await getDb(env);
  const recent = await db
    .prepare(`SELECT SUM(created_at > datetime('now','-10 minutes')) AS m10, COUNT(*) AS d1 FROM annotations WHERE ip_hash = ? AND created_at > datetime('now','-1 day')`)
    .bind(ipHash)
    .first();
  if ((recent?.m10 || 0) >= 5 || (recent?.d1 || 0) >= 30) return fail('提交太频繁了，请稍后再试', 429);
  const onPage = await db.prepare(`SELECT COUNT(*) AS n FROM annotations WHERE page = ?`).bind(d.page).first();
  if ((onPage?.n || 0) >= 300) return fail('这篇文章的批注已经满了', 429);

  const res = await db
    .prepare(`INSERT INTO annotations (page, exact, prefix, suffix, start, body, nickname, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${PUBLIC_COLS}`)
    .bind(d.page, exact, prefix, suffix, start, body, nickname, ipHash)
    .first();
  return json({ annotation: res }, 201);
}
