// 上下叠放、共用时间轴和十字线的折线图。每个面板有自己的纵轴，不做双轴叠画。
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
  domain?: [number, number];
  refs?: { v: number; label: string }[];
}
const NS = 'http://www.w3.org/2000/svg';
const tm = (d: string) => new Date(d + 'T00:00:00Z').getTime();
const fmt = (v: number, d: number) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const el = (n: string, a: Record<string, string>) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };

function nearest(pts: Pt[], t: number): number {
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tm(pts[mid][0]) < t) lo = mid; else hi = mid; }
  return Math.abs(tm(pts[lo][0]) - t) <= Math.abs(tm(pts[hi][0]) - t) ? lo : hi;
}

export function mountChart(box: HTMLElement, panels: Panel[], days: number) {
  box.textContent = '';
  const main = panels[0];
  if (!main || main.points.length < 2) return;
  const W = Math.max(box.clientWidth, 160);
  const tEnd = tm(main.points[main.points.length - 1][0]);
  const tStart = tEnd - days * 86400000;
  const x = (t: number) => ((t - tStart) / (tEnd - tStart)) * W;

  const sliced = panels.map((p) => {
    const s = p.points.filter((q) => tm(q[0]) >= tStart);
    return s.length >= 2 ? s : p.points.slice(-2);
  });

  box.style.position = 'relative';
  const GAP = 10, PAD = 8;
  const dots: SVGCircleElement[] = [];
  const tops: number[] = [];
  let yOff = 0;
  const svg = el('svg', { width: String(W), height: '0', viewBox: `0 0 ${W} 0`, role: 'img' });
  svg.style.display = 'block'; svg.style.touchAction = 'pan-y';
  panels.forEach((p, i) => {
    const pts = sliced[i];
    const vals = pts.map((q) => q[1]);
    let lo = p.domain ? p.domain[0] : Math.min(...vals), hi = p.domain ? p.domain[1] : Math.max(...vals);
    if (!p.domain) { const pv = (hi - lo) * 0.08 || 1; lo -= pv; hi += pv; }
    const TOP = 18;
    const y = (v: number) => yOff + TOP + (1 - (v - lo) / (hi - lo)) * (p.height - TOP - PAD);
    tops.push(yOff);
    const g = el('g', {});
    // 面板标题
    const cap = el('text', { x: '0', y: String(yOff + 11), fill: 'var(--ink-3)', 'font-size': '11' });
    cap.textContent = p.label; g.appendChild(cap);
    // 参考线
    (p.refs ?? []).forEach((r) => {
      g.appendChild(el('line', { x1: '0', x2: String(W), y1: String(y(r.v)), y2: String(y(r.v)), stroke: 'var(--line)', 'stroke-width': '1' }));
      const t = el('text', { x: String(W), y: String(y(r.v) - 3), 'text-anchor': 'end', fill: 'var(--ink-3)', 'font-size': '10.5' });
      t.textContent = r.label; g.appendChild(t);
    });
    const d = pts.map((q, k) => `${k ? 'L' : 'M'}${x(tm(q[0])).toFixed(1)} ${y(q[1]).toFixed(1)}`).join(' ');
    if (p.area) g.appendChild(el('path', { d: `${d} L${x(tm(pts[pts.length - 1][0])).toFixed(1)} ${yOff + p.height} L${x(tm(pts[0][0])).toFixed(1)} ${yOff + p.height} Z`, fill: p.color, opacity: '0.08' }));
    g.appendChild(el('path', { d, fill: 'none', stroke: p.color, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    const last = pts[pts.length - 1];
    g.appendChild(el('circle', { cx: String(x(tm(last[0]))), cy: String(y(last[1])), r: '5', fill: 'var(--bg)' }));
    g.appendChild(el('circle', { cx: String(x(tm(last[0]))), cy: String(y(last[1])), r: '3.5', fill: p.color }));
    svg.appendChild(g);
    const dot = el('circle', { r: '4', fill: p.color, stroke: 'var(--bg)', 'stroke-width': '2', visibility: 'hidden' }) as SVGCircleElement;
    dots.push(dot);
    (dot as any)._y = y;
    yOff += p.height + GAP;
  });
  const H = yOff - GAP;
  svg.setAttribute('height', String(H)); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('aria-label', `${panels.map((p) => p.label).join('、')}走势图`);
  const cross = el('line', { y1: '0', y2: String(H), stroke: 'var(--ink-3)', 'stroke-width': '1', visibility: 'hidden' });
  svg.appendChild(cross); dots.forEach((d) => svg.appendChild(d));
  box.appendChild(svg);

  const tip = document.createElement('div');
  tip.style.cssText = 'position:absolute;top:0;pointer-events:none;visibility:hidden;font:12px var(--mono);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:5px 9px;white-space:nowrap;color:var(--ink);line-height:1.6;z-index:2';
  box.appendChild(tip);

  function show(clientX: number) {
    const r = svg.getBoundingClientRect();
    const t = tStart + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (tEnd - tStart);
    let px = 0; const rows: string[] = []; let date = '';
    panels.forEach((p, i) => {
      const pts = sliced[i]; const k = nearest(pts, t); const q = pts[k];
      const cx = x(tm(q[0])); if (i === 0) { px = cx; date = q[0]; }
      dots[i].setAttribute('cx', String(cx)); dots[i].setAttribute('cy', String((dots[i] as any)._y(q[1]))); dots[i].setAttribute('visibility', 'visible');
      rows.push(`${p.label}  ${p.prefix ?? ''}${fmt(q[1], p.decimals)}${p.suffix ?? ''}`);
    });
    cross.setAttribute('x1', String(px)); cross.setAttribute('x2', String(px)); cross.setAttribute('visibility', 'visible');
    tip.textContent = '';
    const h = document.createElement('div'); h.style.color = 'var(--ink-3)'; h.textContent = date; tip.appendChild(h);
    rows.forEach((s) => { const d = document.createElement('div'); d.textContent = s; tip.appendChild(d); });
    tip.style.visibility = 'visible';
    const tw = tip.offsetWidth;
    tip.style.left = Math.max(0, Math.min(W - tw, px - tw / 2)) + 'px';
    tip.style.top = (H + 6) + 'px';
  }
  function hide() { cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); tip.style.visibility = 'hidden'; }
  svg.addEventListener('pointermove', (e) => show((e as PointerEvent).clientX));
  svg.addEventListener('pointerleave', hide);
  box.style.paddingBottom = '0px';
}
