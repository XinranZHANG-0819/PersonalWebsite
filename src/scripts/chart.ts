// 折线图，左侧带纵坐标；面板可以上下叠放，也可以把第二条线叠到同一张图里（overlay，右侧另设纵轴）。
// 叠画时两条线刻度不同，所以左右轴的刻度文字用各自线条的颜色。
export type Pt = [string, number];
export interface Panel {
  label: string;
  points: Pt[];
  decimals: number;
  prefix?: string;
  suffix?: string;
  color: string;
  height: number;
  area?: boolean;
  caption?: boolean;
  /** 叠到上一个面板的同一张图里，使用右侧纵轴 */
  overlay?: boolean;
  /** 在背景里画色带（比如比特币减半窗口），日期区间 */
  bands?: [string, string][];
  bandLabel?: string;
  domain?: [number, number];
  ticks?: number[];
  refs?: number[];
}
export interface Stats { first: number; last: number; firstDate: string; lastDate: string; }

const NS = 'http://www.w3.org/2000/svg';
const tm = (d: string) => new Date(d + 'T00:00:00Z').getTime();
const fmt = (v: number, d: number) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const el = (n: string, a: Record<string, string>) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };

function niceTicks(lo: number, hi: number, n = 3): { ticks: number[]; decimals: number } {
  const raw = (hi - lo) / n;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  const step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * pow;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(Math.round(v / step) * step);
  return { ticks, decimals: Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) };
}

function nearest(pts: Pt[], t: number): number {
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tm(pts[mid][0]) < t) lo = mid; else hi = mid; }
  return Math.abs(tm(pts[lo][0]) - t) <= Math.abs(tm(pts[hi][0]) - t) ? lo : hi;
}

/** 画图，并返回第一个面板在所选区间内的起止值（用来算区间收益率）。 */
export function mountChart(box: HTMLElement, panels: Panel[], days: number, opts: { L?: number; R?: number } = {}): Stats | null {
  box.textContent = '';
  const main = panels[0];
  if (!main || main.points.length < 2) return null;
  const W = Math.max(box.clientWidth, 200);
  const tEnd = tm(main.points[main.points.length - 1][0]);
  const tStart = tEnd - days * 86400000;

  const sliced = panels.map((p, i) => {
    const idx = p.points.findIndex((q) => tm(q[0]) >= tStart);
    // 主面板严格取窗口内的点；其他线（可能是月度数据）多取窗口前的一个点，让线从左边缘起笔
    const s = idx < 0 ? p.points.slice(-2) : p.points.slice(i === 0 ? idx : Math.max(0, idx - 1));
    return s.length >= 2 ? s : p.points.slice(-2);
  });

  // 纵轴刻度
  const scales = panels.map((p, i) => {
    const vals = sliced[i].map((q) => q[1]);
    let lo = p.domain ? p.domain[0] : Math.min(...vals), hi = p.domain ? p.domain[1] : Math.max(...vals);
    if (!p.domain) { const mn = lo; const pv = (hi - lo) * 0.1 || 1; lo -= pv; hi += pv; if (mn >= 0 && lo < 0) lo = 0; }
    let ticks = p.ticks, dec = p.decimals;
    if (!ticks) { const nt = niceTicks(lo, hi, 3); ticks = nt.ticks; dec = Math.min(p.decimals, nt.decimals); }
    else dec = 0;
    const label = (v: number) => `${p.prefix ?? ''}${fmt(Math.abs(v) < 1e-9 ? 0 : v, dec)}${p.suffix ?? ''}`;
    return { lo, hi, ticks, label };
  });
  const widthOf = (idxs: number[]) => Math.max(0, ...idxs.flatMap((i) => scales[i].ticks.map((t) => scales[i].label(t).length)));
  const leftIdx = panels.map((_, i) => i).filter((i) => !panels[i].overlay);
  const rightIdx = panels.map((_, i) => i).filter((i) => panels[i].overlay);
  const L = opts.L ?? Math.round(widthOf(leftIdx) * 6.4 + 12);
  const R = opts.R ?? (rightIdx.length ? Math.round(widthOf(rightIdx) * 6.4 + 12) : 6);
  const x = (t: number) => L + ((t - tStart) / (tEnd - tStart)) * (W - L - R);

  box.style.position = 'relative';
  const GAP = 12, BOT = 6;
  const dots: SVGCircleElement[] = [];
  const cid = 'cp' + Math.random().toString(36).slice(2, 8);
  const svg = el('svg', { width: String(W), height: '0', viewBox: `0 0 ${W} 0`, role: 'img' });
  const defs = el('defs', {}); const cp = el('clipPath', { id: cid });
  cp.appendChild(el('rect', { x: String(L), y: '-4', width: String(W - L - R), height: '4000' }));
  defs.appendChild(cp); svg.appendChild(defs);
  svg.style.display = 'block'; svg.style.touchAction = 'pan-y'; svg.style.overflow = 'visible';

  let yOff = 0, bandTop = 0, bandH = 0, bandHasOverlay = false;
  const legends: { top: number; items: { label: string; color: string; swatch: 'dot' | 'box' }[] }[] = [];
  panels.forEach((p, i) => {
    const pts = sliced[i];
    const sc = scales[i];
    const over = !!p.overlay && i > 0;
    if (!over) {
      bandTop = yOff; bandH = p.height; bandHasOverlay = panels[i + 1]?.overlay === true;
      if (bandHasOverlay || p.bands) {
        const items: { label: string; color: string; swatch: 'dot' | 'box' }[] = [{ label: p.label, color: p.color, swatch: 'dot' }];
        if (bandHasOverlay) items.push({ label: panels[i + 1].label, color: panels[i + 1].color, swatch: 'dot' });
        if (p.bands) items.push({ label: p.bandLabel ?? '区间', color: 'var(--series2)', swatch: 'box' });
        legends.push({ top: bandTop, items });
      }
    }
    const top0 = bandTop;
    const H0 = bandH;
    const TOP = !over && !bandHasOverlay && p.caption !== false ? 22 : 8;
    const y = (v: number) => top0 + TOP + (1 - (v - sc.lo) / (sc.hi - sc.lo)) * (H0 - TOP - BOT);
    const g = el('g', {});

    // 背景色带（比如比特币减半窗口）
    if (!over && p.bands) {
      p.bands.forEach(([b0, b1]) => {
        const t0 = Math.max(tm(b0), tStart), t1 = Math.min(tm(b1), tEnd);
        if (t1 <= t0) return;
        g.appendChild(el('rect', { x: String(x(t0)), y: String(top0 + TOP), width: String(Math.max(1, x(t1) - x(t0))), height: String(H0 - TOP - BOT), fill: 'var(--series2)', opacity: '0.14' }));
      });
    }

    // 标题（仅上下叠放时）
    if (!over && !bandHasOverlay && p.caption !== false) {
      const cap = el('text', { x: String(L), y: String(top0 + 11), fill: 'var(--ink-3)', 'font-size': '11' });
      cap.textContent = p.label; g.appendChild(cap);
    }

    // 纵坐标：主线在左，叠加线在右（文字用线条颜色）
    sc.ticks.forEach((tv) => {
      const isRef = (p.refs ?? []).includes(tv);
      if (!over || isRef) {
        g.appendChild(el('line', { x1: String(L), x2: String(W - R), y1: String(y(tv)), y2: String(y(tv)), stroke: over ? p.color : (isRef ? 'var(--ink-3)' : 'var(--line)'), 'stroke-opacity': over ? '0.4' : (isRef ? '0.55' : '1'), 'stroke-width': '1', 'stroke-dasharray': over ? '3 3' : '' }));
      }
      const t = el('text', over
        ? { x: String(W - R + 8), y: String(y(tv) + 3.5), 'text-anchor': 'start', fill: p.color, 'font-size': '10.5', 'font-family': 'var(--mono)' }
        : { x: String(L - 8), y: String(y(tv) + 3.5), 'text-anchor': 'end', fill: bandHasOverlay ? panels[i].color : 'var(--ink-3)', 'font-size': '10.5', 'font-family': 'var(--mono)' });
      t.textContent = sc.label(tv); g.appendChild(t);
    });

    const gc = el('g', { 'clip-path': `url(#${cid})` });
    const d = pts.map((q, k) => `${k ? 'L' : 'M'}${x(tm(q[0])).toFixed(1)} ${y(q[1]).toFixed(1)}`).join(' ');
    if (p.area && !over) gc.appendChild(el('path', { d: `${d} L${x(tm(pts[pts.length - 1][0])).toFixed(1)} ${top0 + H0 - BOT} L${x(tm(pts[0][0])).toFixed(1)} ${top0 + H0 - BOT} Z`, fill: p.color, opacity: '0.08' }));
    gc.appendChild(el('path', { d, fill: 'none', stroke: p.color, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    g.appendChild(gc);
    const last = pts[pts.length - 1];
    g.appendChild(el('circle', { cx: String(x(tm(last[0]))), cy: String(y(last[1])), r: '5', fill: 'var(--bg)' }));
    g.appendChild(el('circle', { cx: String(x(tm(last[0]))), cy: String(y(last[1])), r: '3.5', fill: p.color }));
    svg.appendChild(g);

    const dot = el('circle', { r: '4', fill: p.color, stroke: 'var(--bg)', 'stroke-width': '2', visibility: 'hidden' }) as SVGCircleElement;
    (dot as any)._y = y;
    dots.push(dot);
    if (!over) yOff += p.height + GAP;
  });
  // 图例：放在图里左上角，带底色，避免和曲线混在一起
  legends.forEach((lg) => {
    const g = el('g', {});
    const widths = lg.items.map((it) => 14 + it.label.length * 11.5 + 14);
    const total = widths.reduce((a, b) => a + b, 0) + 6;
    const x0 = L + Math.max(6, ((W - L - R) - total) / 2);   // 水平居中于绘图区
    g.appendChild(el('rect', { x: String(x0), y: String(lg.top + 4), width: String(total), height: '20', rx: '5', fill: 'var(--bg)', 'fill-opacity': '0.88' }));
    let lx = x0 + 6;
    lg.items.forEach((it, k) => {
      if (it.swatch === 'dot') g.appendChild(el('circle', { cx: String(lx + 4), cy: String(lg.top + 14), r: '3.5', fill: it.color }));
      else g.appendChild(el('rect', { x: String(lx), y: String(lg.top + 9.5), width: '9', height: '9', fill: it.color, 'fill-opacity': '0.35' }));
      const t = el('text', { x: String(lx + 14), y: String(lg.top + 17.5), fill: 'var(--ink-2)', 'font-size': '11.5' });
      t.textContent = it.label; g.appendChild(t);
      lx += widths[k];
    });
    svg.appendChild(g);
  });
  const H = yOff - GAP;
  svg.setAttribute('height', String(H)); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('aria-label', `${panels.map((p) => p.label).join('、')}走势图`);
  const cross = el('line', { y1: '0', y2: String(H), stroke: 'var(--ink-3)', 'stroke-width': '1', visibility: 'hidden' });
  svg.appendChild(cross); dots.forEach((dd) => svg.appendChild(dd));
  box.appendChild(svg);

  const tip = document.createElement('div');
  tip.style.cssText = 'position:absolute;pointer-events:none;visibility:hidden;font:12px var(--mono);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:5px 9px;white-space:nowrap;color:var(--ink);line-height:1.6;z-index:2';
  box.appendChild(tip);

  function show(clientX: number) {
    const r = svg.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left - L) / (r.width - L - R)));
    const t = tStart + frac * (tEnd - tStart);
    let px = 0; const rows: string[] = []; let date = '';
    panels.forEach((p, i) => {
      const pts = sliced[i]; const q = pts[nearest(pts, t)];
      const cx = Math.max(L, x(tm(q[0]))); if (i === 0) { px = cx; date = q[0]; }
      dots[i].setAttribute('cx', String(cx)); dots[i].setAttribute('cy', String((dots[i] as any)._y(q[1]))); dots[i].setAttribute('visibility', 'visible');
      const far = i > 0 && Math.abs(tm(q[0]) - tm(date)) > 6 * 86400000;
      rows.push(`${p.label}  ${p.prefix ?? ''}${fmt(q[1], p.decimals)}${p.suffix ?? ''}${far ? `  (${q[0].slice(0, 7)})` : ''}`);
    });
    cross.setAttribute('x1', String(px)); cross.setAttribute('x2', String(px)); cross.setAttribute('visibility', 'visible');
    tip.textContent = '';
    const h = document.createElement('div'); h.style.color = 'var(--ink-3)'; h.textContent = date; tip.appendChild(h);
    rows.forEach((s) => { const dv = document.createElement('div'); dv.textContent = s; tip.appendChild(dv); });
    tip.style.visibility = 'visible';
    const tw = tip.offsetWidth;
    tip.style.left = Math.max(L, Math.min(W - tw, px - tw / 2)) + 'px';
    tip.style.top = (H + 6) + 'px';
  }
  function hide() { cross.setAttribute('visibility', 'hidden'); dots.forEach((dd) => dd.setAttribute('visibility', 'hidden')); tip.style.visibility = 'hidden'; }
  svg.addEventListener('pointermove', (e) => show((e as PointerEvent).clientX));
  svg.addEventListener('pointerleave', hide);

  const ms = sliced[0];
  return { first: ms[0][1], last: ms[ms.length - 1][1], firstDate: ms[0][0], lastDate: ms[ms.length - 1][0] };
}
