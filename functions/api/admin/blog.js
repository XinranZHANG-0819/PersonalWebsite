// 站内写文章接口（需要 Cloudflare Access 登录，管理员专用）。
// 文章以 Markdown 文件形式存在 GitHub 仓库 src/content/blog/，
// 本接口用 GitHub Contents API 读写；保存后提交到仓库，
// 下次工作日 06:10 / 17:10 自动重部署上线（或直接 wrangler 部署）。
// 需要的环境变量：GITHUB_TOKEN（细粒度 PAT，只需 Contents 读写
// PersonalWebsite 一个仓库；未配置时接口报 503）、
// GITHUB_REPO（默认 XinranZHANG-0819/PersonalWebsite）、
// GITHUB_BRANCH（默认 claude/nifty-einstein-12pt6v）。
import { json, fail, sameOrigin } from '../../_lib/util.js';
import { requireAdmin } from '../../_lib/access.js';

const BLOG_DIR = 'src/content/blog';
const IMAGE_DIR = 'public/images';
const MAX_CONTENT_BYTES = 200 * 1024; // 正文上限 200KB
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 图片上限 5MB
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];

async function guard(request, env) {
  const email = await requireAdmin(request, env);
  return email ? null : fail('需要管理员登录', 401);
}

function ghEnv(env) {
  if (!env.GITHUB_TOKEN) return null;
  return {
    token: env.GITHUB_TOKEN,
    repo: env.GITHUB_REPO || 'XinranZHANG-0819/PersonalWebsite',
    branch: env.GITHUB_BRANCH || 'claude/nifty-einstein-12pt6v',
  };
}

// UTF-8 安全的 base64 编解码（Workers 里没有 Buffer，btoa 只认 Latin-1）
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}
function fromBase64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function ghFetch(cfg, path, init) {
  let r;
  try {
    r = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'xinran-wiki-blog-editor',
        ...(init && init.headers ? init.headers : {}),
      },
    });
  } catch {
    // 网络本身不通（如沙箱限制）：当作 GitHub 请求失败，不把异常堆栈抛给前端
    return new Response(null, { status: 502 });
  }
  return r;
}

// GitHub 报错映射成通用提示（不把上游原文透传出去）
function ghFail(r) {
  if (r.status === 401 || r.status === 403) return fail('GitHub 授权失败，请检查 GITHUB_TOKEN', 502);
  if (r.status === 404) return fail('文件不存在', 404);
  if (r.status === 409) return fail('文件已被他人修改，请刷新后重试', 409);
  if (r.status === 422) return fail('GitHub 拒绝了这次保存（可能是文件已存在或内容有问题）', 502);
  if (r.status === 429) return fail('GitHub 请求太频繁，请稍后再试', 502);
  return fail('GitHub 请求失败', 502);
}

// 只解析我们自己生成的 frontmatter：title / description / date / tags / draft
function parseFrontmatter(md) {
  const m = String(md).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: String(md) };
  const data = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!mm) continue;
    const k = mm[1];
    let v = mm[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      try { v = JSON.parse(v); } catch { v = v.slice(1, -1); }
    } else if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else if (v === 'true') v = true;
    else if (v === 'false') v = false;
    data[k] = v;
  }
  return { data, body: m[2] };
}

// title / description 用 JSON 双引号转义：合法的 YAML 双引号标量，冒号、引号、中文都没问题
function buildMarkdown({ title, description, date, tags, content, draft }) {
  const lines = ['---', `title: ${JSON.stringify(title)}`];
  if (description) lines.push(`description: ${JSON.stringify(description)}`);
  lines.push(`date: ${date}`);
  if (tags && tags.length) lines.push(`tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]`);
  if (draft) lines.push('draft: true');
  lines.push('---', '', String(content).trim() + '\n');
  return lines.join('\n');
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/; // 如 2026-11-28-my-post
const FILE_RE = /^[^/\\][^/\\]*\.md$/; // 不含斜杠的 .md 文件名，允许中文文件名
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function cleanTags(v) {
  const raw = Array.isArray(v) ? v : String(v ?? '').split(',');
  const out = [];
  for (const t of raw) {
    const s = String(t).replace(/[\u0000-\u001F\u007F]/g, '').trim();
    if (s && s.length <= 30 && !out.includes(s)) out.push(s);
    if (out.length >= 20) break;
  }
  return out;
}

// 图片文件名清洗：只留小写字母数字连字符和点；重复时加 -2、-3
function cleanImageName(name) {
  const base = String(name || '').split('/').pop().split('\\').pop().trim().toLowerCase();
  const m = base.match(/^(.*?)(?:\.([a-z0-9]+))?$/);
  let stem = (m[1] || 'image').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'image';
  let ext = (m[2] || '').toLowerCase();
  if (!IMAGE_EXTS.includes(ext)) ext = 'png';
  if (stem.length > 80) stem = stem.slice(0, 80).replace(/-+$/g, '');
  return { stem, ext };
}

export async function onRequestGet({ request, env }) {
  const denied = await guard(request, env);
  if (denied) return denied;
  const cfg = ghEnv(env);
  if (!cfg) return fail('未配置 GITHUB_TOKEN', 503);
  const url = new URL(request.url);
  const file = url.searchParams.get('file');

  if (file) {
    if (!FILE_RE.test(file) || file.includes('..')) return fail('bad file');
    const r = await ghFetch(cfg, `${BLOG_DIR}/${encodeURIComponent(file)}?ref=${encodeURIComponent(cfg.branch)}`);
    if (!r.ok) return ghFail(r);
    const j = await r.json();
    if (j.type !== 'file' || typeof j.content !== 'string') return fail('不是文章文件', 400);
    const { data, body } = parseFrontmatter(fromBase64(j.content));
    return json({
      file, sha: j.sha,
      title: typeof data.title === 'string' ? data.title : '',
      description: typeof data.description === 'string' ? data.description : '',
      date: typeof data.date === 'string' ? data.date : '',
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      draft: data.draft === true,
      content: body,
    });
  }

  const r = await ghFetch(cfg, `${BLOG_DIR}?ref=${encodeURIComponent(cfg.branch)}`);
  if (!r.ok) return ghFail(r);
  const items = await r.json();
  const files = (Array.isArray(items) ? items : []).filter((it) => it.type === 'file' && it.name.endsWith('.md'));
  const posts = await Promise.all(files.map(async (it) => {
    const fr = await ghFetch(cfg, `${BLOG_DIR}/${encodeURIComponent(it.name)}?ref=${encodeURIComponent(cfg.branch)}`);
    if (!fr.ok) return { file: it.name, sha: it.sha, title: it.name, date: '', tags: [], draft: false };
    const j = await fr.json();
    const { data } = parseFrontmatter(typeof j.content === 'string' ? fromBase64(j.content) : '');
    return {
      file: it.name, sha: it.sha,
      title: typeof data.title === 'string' ? data.title : it.name,
      description: typeof data.description === 'string' ? data.description : '',
      date: typeof data.date === 'string' ? data.date : '',
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      draft: data.draft === true,
    };
  }));
  posts.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(a.file).localeCompare(String(b.file)));
  return json({ posts });
}

async function savePost(request, env) {
  if (!sameOrigin(request)) return fail('forbidden', 403);
  const denied = await guard(request, env);
  if (denied) return denied;
  const cfg = ghEnv(env);
  if (!cfg) return fail('未配置 GITHUB_TOKEN', 503);
  let d;
  try { d = await request.json(); } catch { return fail('bad json'); }

  // 图片上传：{ imageName, dataBase64 }
  if (d.imageName !== undefined || d.dataBase64 !== undefined) {
    if (typeof d.imageName !== 'string' || typeof d.dataBase64 !== 'string') return fail('bad image');
    const b64 = d.dataBase64.replace(/^data:image\/[a-z]+;base64,/, '').replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(b64) || b64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3)) return fail('图片太大或格式不对（上限 5MB）');
    const { stem, ext } = cleanImageName(d.imageName);
    let name = `${stem}.${ext}`;
    for (let n = 2; n <= 100; n++) {
      const check = await ghFetch(cfg, `${IMAGE_DIR}/${encodeURIComponent(name)}?ref=${encodeURIComponent(cfg.branch)}`);
      if (check.status === 404) break;
      if (!check.ok) return ghFail(check);
      name = `${stem}-${n}.${ext}`;
    }
    const r = await ghFetch(cfg, `${IMAGE_DIR}/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: `blog: 上传图片 ${name}（站内编辑器）`, content: b64, branch: cfg.branch }),
    });
    if (!r.ok) return ghFail(r);
    return json({ url: `/images/${name}`, file: name });
  }

  // 文章保存：{ slug, title, description, date, tags, content, draft }
  const slug = String(d.slug || '').trim();
  const title = String(d.title || '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
  const description = String(d.description || '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
  const date = String(d.date || '').trim();
  const content = String(d.content ?? '');
  const draft = d.draft === true;
  if (!SLUG_RE.test(slug) || slug.length > 120) return fail('slug 只允许小写字母、数字、连字符，如 2026-11-28-my-post');
  if (!title || title.length > 200) return fail('主题不能为空（上限 200 字）');
  if (description.length > 500) return fail('摘要太长（上限 500 字）');
  if (!validDate(date)) return fail('日期格式不对，请用 YYYY-MM-DD');
  if (new TextEncoder().encode(content).length > MAX_CONTENT_BYTES) return fail('正文太长（上限 200KB）');
  const tags = cleanTags(d.tags);

  const file = `${slug}.md`;
  const md = buildMarkdown({ title, description, date, tags, content, draft });
  const path = `${BLOG_DIR}/${encodeURIComponent(file)}`;
  const existing = await ghFetch(cfg, `${path}?ref=${encodeURIComponent(cfg.branch)}`);
  let sha;
  if (existing.ok) {
    const j = await existing.json();
    sha = j.sha;
  } else if (existing.status !== 404) {
    return ghFail(existing);
  }
  const body = { message: `blog: 保存《${title}》（站内编辑器）`, content: toBase64(md), branch: cfg.branch };
  if (sha) body.sha = sha;
  const r = await ghFetch(cfg, path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) return ghFail(r);
  const j = await r.json();
  return json({ ok: true, file, sha: j.content && j.content.sha, draft, url: draft ? null : `/blog/${slug}/` });
}

export async function onRequestPost(ctx) { return savePost(ctx.request, ctx.env); }
export async function onRequestPut(ctx) { return savePost(ctx.request, ctx.env); }

export async function onRequestDelete({ request, env }) {
  if (!sameOrigin(request)) return fail('forbidden', 403);
  const denied = await guard(request, env);
  if (denied) return denied;
  const cfg = ghEnv(env);
  if (!cfg) return fail('未配置 GITHUB_TOKEN', 503);
  const file = new URL(request.url).searchParams.get('file') || '';
  if (!FILE_RE.test(file) || file.includes('..')) return fail('bad file');
  const path = `${BLOG_DIR}/${encodeURIComponent(file)}`;
  const existing = await ghFetch(cfg, `${path}?ref=${encodeURIComponent(cfg.branch)}`);
  if (!existing.ok) return ghFail(existing);
  const j = await existing.json();
  const r = await ghFetch(cfg, path, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: `blog: 删除 ${file}（站内编辑器）`, sha: j.sha, branch: cfg.branch }),
  });
  if (!r.ok) return ghFail(r);
  return json({ ok: true });
}
