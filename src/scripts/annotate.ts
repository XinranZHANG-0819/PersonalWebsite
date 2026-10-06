// 文章批注（读者和作者都能用）：选中文字 → 批注；被批注的文字高亮，点开能看内容和作者回复。
// 定位方式：记住被选中的原文 + 前后各几个字，而不是“第几个字”，所以文章小改之后批注还能对上；
// 那段话被删掉的批注，会放进文末的“历史批注”，不会丢。

interface Ann {
  id: number; exact: string; prefix: string; suffix: string; start: number | null;
  body: string; nickname: string; reply: string | null; replied_at: string | null; created_at: string;
}

const root = document.querySelector<HTMLElement>('.prose');
if (root) init(root);

function init(root: HTMLElement) {
  const PAGE = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
  const SITEKEY = document.querySelector('meta[name="turnstile-sitekey"]')?.getAttribute('content') || '';
  const NICK_KEY = 'ann-nickname';
  const anns = new Map<number, Ann>();
  const orphans: Ann[] = [];

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text; // 一律 textContent：批注内容只当纯文本
    return e;
  };

  // ---------- 文本定位 ----------
  const textNodes = (): Text[] => {
    const out: Text[] = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text);
    return out;
  };
  const fullText = () => textNodes().map((n) => n.data).join('');

  function findStart(a: Ann, text: string): number {
    const hits: number[] = [];
    for (let i = text.indexOf(a.exact); i !== -1; i = text.indexOf(a.exact, i + 1)) hits.push(i);
    if (!hits.length) return -1;
    if (hits.length === 1) return hits[0];
    let best = hits[0], bestScore = -1;
    for (const h of hits) {
      let score = 0;
      const before = text.slice(Math.max(0, h - a.prefix.length), h);
      const after = text.slice(h + a.exact.length, h + a.exact.length + a.suffix.length);
      for (let k = 1; k <= Math.min(before.length, a.prefix.length); k++) { if (before[before.length - k] === a.prefix[a.prefix.length - k]) score++; else break; }
      for (let k = 0; k < Math.min(after.length, a.suffix.length); k++) { if (after[k] === a.suffix[k]) score++; else break; }
      if (a.start !== null) score += Math.max(0, 1 - Math.abs(h - a.start) / 2000);
      if (score > bestScore) { bestScore = score; best = h; }
    }
    return best;
  }

  function highlight(a: Ann): boolean {
    const s = findStart(a, fullText());
    if (s < 0) return false;
    const e = s + a.exact.length;
    // 每次包裹后文本节点会被拆开，所以逐段重新取节点
    for (let guard = 0; guard < 200; guard++) {
      let pos = 0, target: { node: Text; from: number; to: number } | null = null;
      for (const n of textNodes()) {
        const len = n.data.length;
        const from = Math.max(s, pos), to = Math.min(e, pos + len);
        if (from < to && !(n.parentElement?.closest(`mark.ann[data-id="${a.id}"]`))) { target = { node: n, from: from - pos, to: to - pos }; break; }
        pos += len;
      }
      if (!target) break;
      const r = document.createRange();
      r.setStart(target.node, target.from); r.setEnd(target.node, target.to);
      const m = el('mark', 'ann'); m.dataset.id = String(a.id);
      r.surroundContents(m);
    }
    return true;
  }

  // ---------- 界面 ----------
  const bar = el('div', 'ann-bar');
  const barText = el('span');
  const barToggle = el('button', 'ann-link', '隐藏批注'); barToggle.type = 'button';
  bar.append(barText, barToggle);
  root.before(bar);
  barToggle.addEventListener('click', () => {
    const off = root.classList.toggle('ann-off');
    barToggle.textContent = off ? '显示批注' : '隐藏批注';
  });
  const updateBar = () => {
    const n = anns.size + orphans.length;
    barText.textContent = n ? `本文有 ${n} 条批注。选中文字就可以添加你的批注。` : '选中文字，就可以添加批注。';
    barToggle.hidden = n === 0;
  };

  const btn = el('button', 'ann-pop', '批注'); btn.type = 'button'; btn.hidden = true;
  document.body.append(btn);
  const card = el('div', 'ann-card'); card.hidden = true; card.setAttribute('role', 'dialog');
  document.body.append(card);

  const fmtDate = (s: string) => s.slice(0, 10);
  const closeCard = () => { card.hidden = true; card.textContent = ''; };
  function placeCard(rect: DOMRect | null) {
    if (window.innerWidth <= 720 || !rect) { card.classList.add('sheet'); card.style.left = card.style.top = ''; return; }
    card.classList.remove('sheet');
    const w = Math.min(360, window.innerWidth - 24);
    const left = Math.max(12, Math.min(window.innerWidth - w - 12, rect.left));
    const below = rect.bottom + 10;
    card.style.width = w + 'px';
    card.style.left = left + 'px';
    card.style.top = (below + 280 > window.innerHeight ? Math.max(12, rect.top - 10 - 280) : below) + 'px';
  }

  function noteView(a: Ann): HTMLElement {
    const box = el('div', 'ann-note');
    const head = el('div', 'ann-meta');
    head.append(el('b', undefined, a.nickname || '匿名读者'), el('span', undefined, fmtDate(a.created_at)));
    box.append(head, el('p', 'ann-body', a.body));
    if (a.reply) {
      const r = el('div', 'ann-reply');
      r.append(el('b', undefined, '作者回复'), el('p', 'ann-body', a.reply));
      box.append(r);
    }
    return box;
  }

  function openNotes(ids: number[], rect: DOMRect | null) {
    card.textContent = '';
    const head = el('div', 'ann-card-head');
    head.append(el('b', undefined, `批注（${ids.length}）`));
    const x = el('button', 'ann-x', '×'); x.type = 'button'; x.setAttribute('aria-label', '关闭'); x.addEventListener('click', closeCard);
    head.append(x);
    card.append(head);
    const first = anns.get(ids[0]);
    if (first) card.append(el('blockquote', 'ann-quote', first.exact.length > 90 ? first.exact.slice(0, 90) + '…' : first.exact));
    const list = el('div', 'ann-list');
    ids.forEach((id) => { const a = anns.get(id); if (a) list.append(noteView(a)); });
    card.append(list);
    card.hidden = false; placeCard(rect);
  }

  root.addEventListener('click', (e) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const first = (e.target as HTMLElement).closest?.('mark.ann') as HTMLElement | null;
    if (!first || root.classList.contains('ann-off')) return;
    const ids: number[] = [];
    for (let m: HTMLElement | null = first; m; m = m.parentElement?.closest('mark.ann') as HTMLElement | null) ids.push(Number(m.dataset.id));
    openNotes([...new Set(ids)], first.getBoundingClientRect());
  });

  // ---------- 选中文字 → 批注按钮 ----------
  interface Pending { exact: string; prefix: string; suffix: string; start: number; rect: DOMRect }
  let pending: Pending | null = null;
  function readSelection(): Pending | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;
    let exact = range.toString();
    const lead = exact.length - exact.trimStart().length;
    exact = exact.trim();
    if (!exact || exact.length > 400) return null;
    const pre = document.createRange();
    pre.selectNodeContents(root); pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length + lead;
    const text = fullText();
    return { exact, start, prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(start + exact.length, start + exact.length + 32), rect: range.getBoundingClientRect() };
  }
  const refreshPop = () => {
    if (!card.hidden && card.dataset.mode === 'compose') return;
    const p = readSelection();
    if (!p) { btn.hidden = true; return; }
    pending = p;
    // 选区整个滚出屏幕时，不要让按钮留在屏幕外
    if (p.rect.bottom < 0 || p.rect.top > window.innerHeight) { btn.hidden = true; return; }
    btn.hidden = false;
    const left = Math.max(8, Math.min(window.innerWidth - 72, p.rect.right - 20));
    btn.style.left = left + 'px';
    btn.style.top = Math.min(window.innerHeight - 48, Math.max(8, p.rect.top - 42)) + 'px';
  };
  document.addEventListener('selectionchange', () => { window.setTimeout(refreshPop, 0); });
  window.addEventListener('scroll', () => { if (!btn.hidden) refreshPop(); }, { passive: true });
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // 点按钮时不要丢掉选区

  // ---------- 写批注 ----------
  let tsLoaded: Promise<void> | null = null;
  const loadTurnstile = () => tsLoaded ??= new Promise<void>((res, rej) => {
    if ((window as any).turnstile) return res();
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true; s.onload = () => res(); s.onerror = () => rej(new Error('load'));
    document.head.append(s);
  });

  function openComposer() {
    if (!pending) return;
    const p = pending;
    btn.hidden = true;
    card.textContent = ''; card.dataset.mode = 'compose';
    const head = el('div', 'ann-card-head');
    head.append(el('b', undefined, '添加批注'));
    const x = el('button', 'ann-x', '×'); x.type = 'button'; x.setAttribute('aria-label', '关闭'); x.addEventListener('click', () => { delete card.dataset.mode; closeCard(); });
    head.append(x);
    card.append(head, el('blockquote', 'ann-quote', p.exact.length > 90 ? p.exact.slice(0, 90) + '…' : p.exact));

    const ta = el('textarea', 'ann-input'); ta.rows = 4; ta.maxLength = 1000; ta.placeholder = '写下你的想法（不能放链接）'; ta.id = 'ann-body';
    const nick = el('input', 'ann-input'); nick.type = 'text'; nick.maxLength = 24; nick.placeholder = '昵称（可不填）'; nick.id = 'ann-nick';
    try { nick.value = localStorage.getItem(NICK_KEY) || ''; } catch { /* ignore */ }
    const trap = el('input'); trap.type = 'text'; trap.name = 'website'; trap.tabIndex = -1; trap.autocomplete = 'off'; trap.className = 'ann-trap'; trap.setAttribute('aria-hidden', 'true');
    const ts = el('div', 'ann-ts');
    const msg = el('p', 'ann-msg');
    const row = el('div', 'ann-actions');
    const cancel = el('button', 'ann-btn ghost', '取消'); cancel.type = 'button';
    const send = el('button', 'ann-btn', '提交'); send.type = 'button';
    row.append(cancel, send);
    card.append(ta, nick, trap, ts, msg, row);
    card.hidden = false; placeCard(p.rect);
    ta.focus();

    let token = '';
    if (!SITEKEY) { msg.textContent = '批注功能暂未开启。'; send.disabled = true; }
    else {
      msg.textContent = '正在加载人机验证…';
      loadTurnstile().then(() => {
        msg.textContent = '';
        (window as any).turnstile.render(ts, { sitekey: SITEKEY, theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark', callback: (t: string) => { token = t; } });
      }).catch(() => { msg.textContent = '人机验证加载失败，请检查网络后重试。'; });
    }
    cancel.addEventListener('click', () => { delete card.dataset.mode; closeCard(); });
    send.addEventListener('click', async () => {
      const body = ta.value.trim();
      if (!body) { msg.textContent = '请先写点内容。'; return; }
      if (!token) { msg.textContent = '请先完成人机验证。'; return; }
      send.disabled = true; msg.textContent = '提交中…';
      try { localStorage.setItem(NICK_KEY, nick.value.trim()); } catch { /* ignore */ }
      try {
        const r = await fetch('/api/annotations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page: PAGE, exact: p.exact, prefix: p.prefix, suffix: p.suffix, start: p.start, body, nickname: nick.value.trim(), token, website: trap.value }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { msg.textContent = j.error || '提交失败，请稍后再试。'; send.disabled = false; try { (window as any).turnstile?.reset(); token = ''; } catch { /* ignore */ } return; }
        const a: Ann | undefined = j.annotation;
        delete card.dataset.mode;
        window.getSelection()?.removeAllRanges();
        if (a) {
          anns.set(a.id, a);
          if (!highlight(a)) { anns.delete(a.id); orphans.push(a); }
          updateBar();
          openNotes([a.id], root.querySelector(`mark.ann[data-id="${a.id}"]`)?.getBoundingClientRect() || null);
        } else closeCard();
      } catch {
        msg.textContent = '网络出错了，请稍后再试。'; send.disabled = false;
      }
    });
  }
  btn.addEventListener('click', openComposer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { delete card.dataset.mode; closeCard(); btn.hidden = true; } });

  // ---------- 读取已有批注 ----------
  function renderOrphans() {
    document.getElementById('ann-orphans')?.remove();
    if (!orphans.length) return;
    const sec = el('section', 'ann-orphans'); sec.id = 'ann-orphans';
    sec.append(el('h2', undefined, '历史批注'), el('p', 'ann-hint', '这些批注针对的原文后来被修改了，所以没法标在正文里。'));
    orphans.forEach((a) => { const q = el('blockquote', 'ann-quote', a.exact); sec.append(q, noteView(a)); });
    root.after(sec);
  }
  fetch('/api/annotations?page=' + encodeURIComponent(PAGE))
    .then((r) => (r.ok ? r.json() : { annotations: [] }))
    .then((j: { annotations: Ann[] }) => {
      for (const a of j.annotations || []) { if (highlight(a)) anns.set(a.id, a); else orphans.push(a); }
      updateBar(); renderOrphans();
    })
    .catch(() => { updateBar(); });
  updateBar();
}
