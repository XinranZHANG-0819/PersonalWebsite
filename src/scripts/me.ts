// 私人资产页：登录、导入数据、计算收益与建议、绘图。
// 所有文字都用 textContent 写入；个人数据只来自 /api/me/data（需要登录），不在页面源码里。

type Pt = [string, number];
const PUB: any = JSON.parse(document.getElementById('me-public')!.textContent || '{}');
const MINUS = '−';
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id: string) => document.getElementById(id)!;

/* ===== 小工具 ===== */
function el(tag: string, cls?: string | null, text?: string | null): any {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const SVGNS = 'http://www.w3.org/2000/svg';
function S(tag: string, attrs: Record<string, any>, parent?: Element): any {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(e);
  return e;
}
const fmt = (v: number, d = 2) => Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (v: number, d = 2) => (v < 0 ? MINUS : '') + fmt(v, d);
function signed(v: number, d = 2, suf = '') {
  if (Math.abs(v) < Math.pow(10, -d) / 2) return (0).toFixed(d) + suf;
  return (v > 0 ? '+' : MINUS) + fmt(v, d) + suf;
}
const yuan = (v: number, d = 0) => (v < 0 ? MINUS : '') + '¥' + fmt(v, d);
const syuan = (v: number, d = 2) => (v > 0 ? '+' : v < 0 ? MINUS : '') + '¥' + fmt(v, d);
const dir = (v: number | null | undefined) => (v == null ? '' : Math.abs(v) < 0.005 ? 'flat' : v > 0 ? 'up' : 'down');
const day = (s: string) => Date.parse(s + 'T00:00:00Z');
const floor500 = (v: number) => Math.floor(v / 500) * 500;
const round500 = (v: number) => Math.round(v / 500) * 500;

/* ===== 行情 ===== */
const CSI: Pt[] = PUB.csi300 || [];
function px(d: string) { let b: Pt | null = null; for (const x of CSI) { if (x[0] <= d) b = x; else break; } return b ? b[1] : NaN; }
const monthEnd = (m: string) => { const [y, mo] = m.split('-').map(Number); return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`; };

/* ===== 收益计算 ===== */
function xirr(cf: [string, number][]) {
  if (cf.length < 2) return null;
  const t0 = day(cf[0][0]);
  const npv = (r: number) => cf.reduce((s, [d, a]) => s + a / Math.pow(1 + r, (day(d) - t0) / 864e5 / 365), 0);
  let lo = -0.99, hi = 1.5;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (npv(mid) > 0) lo = mid; else hi = mid; }
  return ((lo + hi) / 2) * 100;
}

// 时间加权：按月切段，月内的钱按到账日加权（修正 Dietz），各月连乘
function twr(monthly: [string, number][], flows: any[]) {
  const byM: Record<string, any[]> = {};
  flows.forEach((f) => { (byM[f.date.slice(0, 7)] ||= []).push(f); });
  let prev = 0, cum = 1;
  const out: { m: string; v: number; r: number; cum: number }[] = [];
  monthly.forEach(([m, v]) => {
    const D = Number(monthEnd(m).slice(8));
    const fl = byM[m] || [];
    const F = fl.reduce((s, f) => s + f.amount, 0);
    const W = fl.reduce((s, f) => s + f.amount * (D - Number(f.date.slice(8))) / D, 0);
    const base = prev + W;
    const r = base > 0 ? (v - prev - F) / base : 0;
    cum *= 1 + r;
    out.push({ m, v, r, cum: (cum - 1) * 100 });
    prev = v;
  });
  return out;
}

function compute(data: any) {
  const asOf: string = data.asOf;
  const flows = [...data.flows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const accts: any = {};
  for (const key of ['invest', 'pension']) {
    const a = data.accounts[key];
    if (!a) continue;
    const hs = data.holdings.filter((h: any) => h.account === key);
    const total = hs.reduce((s: number, h: any) => s + h.amount, 0) + (a.cash || 0);
    const extra = (a.extra || []).reduce((s: number, x: any) => s + (x.pnl || 0), 0);
    const pnl = hs.reduce((s: number, h: any) => s + (h.pnl || 0), 0) + extra;
    const classes = (a.classes || []).map((c: any) => {
      const ch = hs.filter((h: any) => h.class === c.id);
      const amt = ch.reduce((s: number, h: any) => s + h.amount, 0);
      const cp = ch.reduce((s: number, h: any) => s + (h.pnl || 0), 0);
      const cost = amt - cp;
      const m1 = amt > 0 ? ch.reduce((s: number, h: any) => s + h.amount * (h.m1 || 0), 0) / amt : null;
      const act = total > 0 ? (amt / total) * 100 : 0;
      const gap = c.target != null ? (c.target / 100) * total - amt : null;
      return { ...c, holdings: ch, amt, pnl: cp, ret: cost > 0 && ch.length ? (cp / cost) * 100 : null, m1: ch.length ? m1 : null, act, gap };
    });
    const af = flows.filter((f) => f.account === key);
    const start = af[0]?.date;
    const days = start ? (day(asOf) - day(start)) / 864e5 : 0;
    const before = af.filter((f) => f.date < asOf).reduce((s, f) => s + f.amount, 0);
    let rate: number | null = null, rateLabel = '';
    if (days >= 365) { rate = xirr([...af.map((f) => [f.date, -f.amount] as [string, number]), [asOf, total]]); rateLabel = '年化'; }
    else if (before > 0) { rate = (pnl / before) * 100; rateLabel = `${Number(start.slice(5, 7))} 月建仓以来`; }
    const year = asOf.slice(0, 4);
    const dep = (a.deposits || []).filter((d: any) => d.date.startsWith(year)).reduce((s: number, d: any) => s + d.amount, 0);
    accts[key] = { key, ...a, hs, total, pnl, classes, rate, rateLabel, dep, year };
  }
  const invTotal = (accts.invest?.total || 0) + (accts.pension?.total || 0);
  const totalAssets = invTotal + (data.cashAssets?.amount || 0);
  const profit = (accts.invest?.pnl || 0) + (accts.pension?.pnl || 0);
  const flowSum = flows.reduce((s, f) => s + f.amount, 0);
  const myX = xirr([...flows.map((f) => [f.date, -f.amount] as [string, number]), [asOf, invTotal]]);
  const units = flows.reduce((s, f) => s + f.amount / px(f.date), 0);
  const bmVal = units * px(asOf);
  const bmX = xirr([...flows.map((f) => [f.date, -f.amount] as [string, number]), [asOf, bmVal]]);
  const series = twr(data.monthly, flows);
  const first = flows[0]?.date;
  const base = px(first);
  const bmSeries = series.map((s) => (px(s.m === asOf.slice(0, 7) ? asOf : monthEnd(s.m)) / base - 1) * 100);
  // 每年：我的（各月连乘）与沪深300（同一时段）
  const years: any[] = [];
  const ys = [...new Set(series.map((s) => s.m.slice(0, 4)))];
  ys.forEach((y) => {
    const ms = series.filter((s) => s.m.startsWith(y));
    const me = (ms.reduce((g, s) => g * (1 + s.r), 1) - 1) * 100;
    const from = first > `${Number(y) - 1}-12-31` ? first : `${Number(y) - 1}-12-31`;
    const to = asOf < `${y}-12-31` ? asOf : `${y}-12-31`;
    years.push({ y, me, bm: (px(to) / px(from) - 1) * 100, ytd: to !== `${y}-12-31` });
  });
  return { asOf, accts, totalAssets, invTotal, profit, flowSum, myX, bmVal, bmGain: bmVal - flowSum, bmX, series, bmSeries, years, first };
}

/* ===== 操作建议：每类资产看三项信号，得出 1–5 级 ===== */
const LV = ['', '不买', '持有', '可以买', '分批买入', '积极买入'];
function btcWindow(today: string) {
  const H: string[] = PUB.halvings || [];
  const addM = (d: string, m: number) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCMonth(t.getUTCMonth() + m); return t.toISOString().slice(0, 10); };
  for (const h of H) {
    const s = addM(h, -PUB.before), e = addM(h, PUB.after);
    if (today < s) return { inside: false, start: s.slice(0, 7), end: e.slice(0, 7) };
    if (today <= e) return { inside: true, start: s.slice(0, 7), end: e.slice(0, 7) };
  }
  return { inside: false, start: '', end: '' };
}
function advise(C: any, data: any) {
  const inv = C.accts.invest;
  if (!inv) return null;
  const cls = (id: string) => inv.classes.find((c: any) => c.id === id) || { act: 0, target: 0, gap: 0, name: id };
  const st = PUB.stats || {};
  const sg = (v: number | null | undefined, d = 1) => (v == null ? '—' : signed(v, d, '%'));
  const pos = (c: any) => {
    const under = c.target - c.act > 2;
    if (!c.target) return ['仓位', '目标 0%', -1];
    if (under) return ['仓位', `${c.act.toFixed(1)}% / 目标 ${c.target}%，差 ¥${fmt(c.gap, 0)}`, 1];
    if (c.act - c.target > 2) return ['仓位', `${c.act.toFixed(1)}% / 目标 ${c.target}%，超 ¥${fmt(-c.gap, 0)}`, -1];
    return ['仓位', `${c.act.toFixed(1)}% / 目标 ${c.target}%，已达标`, -1];
  };
  const out: any[] = [];
  const rb = data.settings?.rebalanceMonth || 12;

  // A 股
  {
    const c = cls('cn-stock'), pb = PUB.pb300?.value, m = st.csi300 || {};
    const v = pb == null ? ['估值', 'PB 分位暂无数据', 0] : pb < 30 ? ['估值', `沪深300 PB 分位 ${pb.toFixed(1)}%，低于 30% 的低估线`, 1] : pb > 70 ? ['估值', `沪深300 PB 分位 ${pb.toFixed(1)}%，高于 70%，偏贵`, -1] : ['估值', `沪深300 PB 分位 ${pb.toFixed(1)}%，处于 30%–70% 的中间区`, 0];
    const mk = ['行情', `近 1 月 ${sg(m.m1)}，距一年高点 ${sg(m.offHigh, 0)}`, (m.m1 ?? 0) <= -5 || (m.offHigh ?? 0) <= -15 ? 1 : (m.m1 ?? 0) >= 8 ? -1 : 0];
    const p = pos(c);
    let lv = 2;
    if (pb == null) lv = c.target - c.act > 2 ? 3 : 2;
    else if (pb > 70) lv = 1;
    else if (pb < 30) lv = c.act < 35 ? 5 : 2;
    else lv = c.target - c.act > 2 ? 4 : 2;
    const all3 = v[2] === 1 && mk[2] === 1 && p[2] === 1;
    const why = lv === 5 ? (all3 ? '三项都支持买。' : 'PB 分位进入低估区。') + '分两次买，留出再跌的余地；PB 分位跌破 20% 时可以超过目标。'
      : lv === 4 ? 'PB 分位在中间区，低配就分两到三次补到目标。'
      : lv === 1 ? 'PB 分位高于 70%，偏贵，不买；已有的继续持有。'
      : lv === 3 ? '低配，可以补到目标。' : pb != null && pb < 30 ? '已经超过 35%，先不加。' : '已达标，持有。';
    out.push({ id: 'cn-stock', n: c.name || 'A 股', c, lv, sig: [v, mk, p], why, cond: pb != null && pb < 30 ? 'PB 分位仍低于 30% 时' : 'PB 分位仍低于 70% 时' });
  }
  // 国内债
  {
    const c = cls('cn-bond'), y = PUB.cn10y?.value, b = st.cbond || {};
    const v = y == null ? ['利率', '国债收益率暂无数据', 0] : y < 2 ? ['利率', `10 年国债 ${y.toFixed(2)}%，处于低位，债券不便宜`, 0] : y > 2.8 ? ['利率', `10 年国债 ${y.toFixed(2)}%，处于高位，债券性价比高`, 1] : ['利率', `10 年国债 ${y.toFixed(2)}%，处于中间水平`, 0];
    const mk = ['行情', `中债新综指近 1 年 ${sg(b.y1)}，最大回撤 ${sg(b.mdd, 2)}`, 0];
    const p = pos(c), lv = c.target - c.act > 2 ? 3 : 2;
    out.push({ id: 'cn-bond', n: c.name || '国内债', c, lv, sig: [v, mk, p], why: lv === 3 ? '长期策略对债券不择时，低配就补，一次买入即可。' : '已达标，持有。' });
  }
  // 纳指 100
  {
    const c = cls('us-stock'), x = PUB.excape?.value, m = st.ndx || {};
    const v = ['估值', x == null ? '超额 CAPE 暂无数据' : `超额 CAPE 收益率 ${signed(x, 2, '%')}（待研究，仅参考）`, 0];
    const deep = (m.offHigh ?? 0) <= -15;
    const mk = ['行情', `近 1 月 ${sg(m.m1)}，距一年高点 ${sg(m.offHigh, 0)}`, deep ? 1 : 0];
    const p = pos(c);
    let lv = 2, act = '';
    if (c.target - c.act > 2) lv = 3;
    else if (deep && c.act < c.target + 5) { lv = 3; act = '小额加仓'; }
    out.push({ id: 'us-stock', n: c.name || '纳指 100', c, lv, act, sig: [v, mk, p], small: !!act, why: lv === 3 ? (act ? '距高点回撤超过 15%，可以小额加。' : '低配，可以分批补到目标。') : '仓位已满，回调也不深。距高点回撤超过 15% 时可以小额加。' });
  }
  // 黄金
  {
    const c = cls('gold'), g = PUB.goldMom24, m = st.gold || {};
    const v = ['趋势', g == null ? '动量暂无数据' : `24 个月动量 ${signed(g, 1, '%')}，长期${g > 0 ? '仍向上' : '转弱'}`, 0];
    const deep = (m.offHigh ?? 0) <= -15;
    const mk = ['行情', `近 1 月 ${sg(m.m1)}，距一年高点 ${sg(m.offHigh, 0)}`, deep ? 1 : 0];
    const p = pos(c), lv = c.target - c.act > 2 ? 3 : 2;
    const over = c.act - c.target > 2;
    out.push({ id: 'gold', n: c.name || '黄金', c, lv, sig: [v, mk, p], why: lv === 3 ? '低配就补；不追涨也不抄底，分季度买。' : over ? `${deep ? '跌得不少，但' : ''}已经超配。先不加，${rb} 月再平衡时决定是否减回 ${c.target}%。` : '已达标，持有。' });
  }
  // 比特币
  const win = btcWindow(PUB.date || C.asOf);
  {
    const c = cls('btc'), m = st.btc || {};
    const v = win.inside ? ['周期', `在减半窗口内，至 ${win.end}`, 1] : ['周期', `不在减半窗口，${win.start} 开启`, -1];
    const deep = (m.offHigh ?? 0) <= -20;
    const mk = ['行情', `近 1 年 ${sg(m.y1, 0)}，距一年高点 ${sg(m.offHigh, 0)}`, deep ? 1 : 0];
    const p = pos(c);
    const lv = win.inside ? (c.target - c.act > 2 ? 4 : 2) : 1;
    out.push({ id: 'btc', n: c.name || '比特币', c, lv, act: win.inside ? (lv === 4 ? '买到目标' : '') : '等待窗口', fixedAmt: win.inside ? '' : `${win.start} 开启`, sig: [v, mk, p], why: win.inside ? '在窗口内，买到目标 5%。' : `长期策略只在减半窗口内持有。${deep ? '价格虽然大跌，' : ''}窗口开启前不买。` });
  }
  // 美债
  {
    const c = cls('us-bond'), y = PUB.us10y?.value, m = st.ief || {};
    const high = y != null && y >= 4.5;
    out.push({ id: 'us-bond', n: '美债', c, lv: 1, act: '不配置', fixedAmt: '目标 0%', sig: [['利率', y == null ? '美债收益率暂无数据' : `10 年美债 ${y.toFixed(2)}%，处于${high ? '高位' : '中间水平'}`, high ? 1 : 0], ['行情', `IEF 近 1 月 ${sg(m.m1)}，近 1 年 ${sg(m.y1)}`, 0], ['仓位', 'Q3 配置不含美债', -1]], why: '不在配置里。' + (high ? '收益率较高，想加入的话可以另做研究。' : '') });
  }

  // 现金分配：强度高的先分；金额按 ¥500 取整
  let left = inv.cash || 0;
  [...out].filter((a) => a.lv >= 3 && (a.c.gap > 0 || a.small)).sort((a, b) => b.lv - a.lv || b.c.gap - a.c.gap).forEach((a) => {
    const gap = a.small ? Math.min(1000, left) : a.c.gap;
    let now = a.lv === 5 ? floor500(gap * 0.6) : a.lv === 4 ? floor500(gap / 2) : floor500(Math.min(gap, left));
    now = Math.min(now, floor500(left));
    if (now < 500) return;
    a.now = now; left -= now;
    if (a.lv >= 4) { const nx = round500(gap - now); if (nx >= 500) a.next = nx; }
  });
  out.forEach((a) => {
    a.act = a.act || LV[a.lv];
    a.amt = a.fixedAmt || (a.now ? `本月 ¥${fmt(a.now, 0)}` + (a.next ? ` · 下月 ¥${fmt(a.next, 0)}` : '') : a.lv <= 2 ? '不加仓' : '现金不够，下次再买');
  });

  // 养老金：跟随 A 股的估值
  const pen = C.accts.pension, aLv = out[0].lv;
  let penPlan: any = null;
  if (pen && pen.cash >= 500) {
    const months = aLv === 5 ? 3 : aLv === 4 ? 6 : 0;
    penPlan = months ? { months, each: Math.round(pen.cash / months / 100) * 100, why: aLv === 5 ? 'A 股在低估区，可以开始投' : 'A 股估值中性，拉长到半年投完' } : { months: 0, why: 'A 股估值偏高，先放着，等 PB 分位回落' };
  }
  return { list: out, left, pen: penPlan, win, rb, goldOver: cls('gold').act - cls('gold').target > 2 ? -cls('gold').gap : 0 };
}

/* ===== 绘图 ===== */
function nice(min: number, max: number, n: number) {
  const span = max - min || 1, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).filter((s) => s >= raw)[0];
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, t: number[] = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) t.push(+v.toFixed(8));
  return { lo, hi, ticks: t };
}
const pct = (t: number) => (t > 0 ? '+' : t < 0 ? MINUS : '') + Math.abs(t) + '%';
const wan = (v: number) => (v === 0 ? '0' : Math.abs(v) >= 10000 ? (v / 10000).toFixed(v % 10000 ? 1 : 0) + '万' : v.toLocaleString('en-US'));
let uid = 0;
function lineChart(box: HTMLElement, xs: string[], series: any[], o: any) {
  const id = 'g' + ++uid;
  box.textContent = '';
  const W = box.clientWidth, H = box.clientHeight, L = o.left || 46, R = 66, T = 14, B = 26, n = xs.length;
  if (n < 2 || W < 50) return;
  const all: number[] = [];
  series.forEach((s) => all.push(...s.v));
  let mn = Math.min(...all), mx = Math.max(...all);
  if (o.zero) { mn = Math.min(mn, 0); mx = Math.max(mx, 0); }
  const sc = nice(mn, mx, 4);
  const X = (i: number) => L + (i / (n - 1)) * (W - L - R);
  const Y = (v: number) => T + (1 - (v - sc.lo) / (sc.hi - sc.lo)) * (H - T - B);
  const svg = S('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', tabindex: 0, 'aria-label': `${o.label}，${xs[0]} 至 ${xs[n - 1]}。` + series.map((s) => `${s.name}最新 ${o.fmt(s.v[n - 1])}`).join('，') + '。可用左右方向键逐月查看。' }, box);
  const defs = S('defs', {}, svg);
  const lg = S('linearGradient', { id: id + 'l', x1: 0, x2: 1, y1: 0, y2: 0 }, defs);
  S('stop', { offset: 0, style: 'stop-color:var(--accent)' }, lg); S('stop', { offset: 1, style: 'stop-color:var(--accent-2)' }, lg);
  const ag = S('linearGradient', { id: id + 'a', x1: 0, x2: 0, y1: 0, y2: 1 }, defs);
  S('stop', { offset: 0, style: 'stop-color:var(--accent);stop-opacity:.24' }, ag); S('stop', { offset: 1, style: 'stop-color:var(--accent);stop-opacity:0' }, ag);
  sc.ticks.forEach((t) => {
    S('line', { x1: L, x2: W - R + 8, y1: Y(t), y2: Y(t), class: t === 0 && o.zero ? 'zero' : 'gl' }, svg);
    S('text', { x: L - 10, y: Y(t) + 3.5, 'text-anchor': 'end', class: 'ax' }, svg).textContent = o.tick(t);
  });
  xs.forEach((x, i) => {
    const m = +x.slice(5); let lab: string | null = null;
    if (n > 14) { if (m === 1) lab = x.slice(0, 4); } else if ((m - 1) % 2 === 0) lab = m === 1 ? x.slice(0, 4) : m + '月';
    if (lab && X(i) > L + 12 && X(i) < W - R) S('text', { x: X(i), y: H - 6, 'text-anchor': 'middle', class: 'ax' }, svg).textContent = lab;
  });
  const ends: any[] = [];
  series.slice().reverse().forEach((s) => {
    const d = s.v.map((v: number, i: number) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ');
    if (s.main && o.area) S('path', { d: `${d} L${X(n - 1)} ${Y(sc.lo)} L${X(0)} ${Y(sc.lo)} Z`, fill: `url(#${id}a)` }, svg);
    const p = S('path', { d, class: 'ln' + (s.main ? ' main' : '') }, svg);
    if (s.main) p.setAttribute('stroke', `url(#${id}l)`); else p.style.stroke = 'var(--bench)';
    if (!reduce && o.animate) { const len = p.getTotalLength(); p.style.strokeDasharray = len; p.style.strokeDashoffset = len; p.getBoundingClientRect(); p.classList.add('draw'); requestAnimationFrame(() => { p.style.strokeDashoffset = 0; }); }
    ends.push({ s, y: Y(s.v[n - 1]) });
  });
  ends.sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 15) { const mid = (ends[k].y + ends[k - 1].y) / 2; ends[k - 1].ly = mid - 8; ends[k].ly = mid + 8; }
  ends.forEach((e) => {
    S('circle', { cx: X(n - 1), cy: e.y, r: 6, style: 'fill:var(--card-solid)' }, svg);
    S('circle', { cx: X(n - 1), cy: e.y, r: 4, style: 'fill:' + (e.s.main ? 'var(--accent-2)' : 'var(--bench)') }, svg);
    S('text', { x: X(n - 1) + 11, y: (e.ly ?? e.y) + 4, class: 'endlab' + (e.s.main ? '' : ' bm') }, svg).textContent = o.fmt(e.s.v[n - 1]);
  });
  const hv = S('line', { y1: T, y2: H - B, class: 'hv', visibility: 'hidden' }, svg);
  const dots = series.map((s) => { const g = S('g', { visibility: 'hidden' }, svg); S('circle', { r: 6, style: 'fill:var(--card-solid)' }, g); S('circle', { r: 4, style: 'fill:' + (s.main ? 'var(--accent-2)' : 'var(--bench)') }, g); return g; });
  const tip = el('div', 'tip'), td = el('div', 'd'); tip.appendChild(td);
  const trs = series.map((s) => { const r = el('div', 'row'), i = el('i'); i.style.background = s.main ? 'var(--accent-2)' : 'var(--bench)'; r.appendChild(i); const b = el('b'); r.appendChild(b); r.appendChild(el('span', null, s.name)); tip.appendChild(r); return b; });
  box.appendChild(tip);
  let cur = n - 1;
  const show = (i: number) => {
    cur = i; const x = X(i);
    hv.setAttribute('visibility', 'visible'); hv.setAttribute('x1', x); hv.setAttribute('x2', x);
    series.forEach((s, k) => { dots[k].setAttribute('visibility', 'visible'); dots[k].setAttribute('transform', `translate(${x},${Y(s.v[i])})`); trs[k].textContent = o.fmt(s.v[i]); });
    td.textContent = xs[i]; tip.style.opacity = '1';
    const tw = tip.offsetWidth; let left = x + 14; if (left + tw > W) left = x - tw - 14;
    tip.style.left = left + 'px'; tip.style.top = T + 'px';
  };
  const hide = () => { hv.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); tip.style.opacity = '0'; };
  const hit = S('rect', { x: L, y: 0, width: Math.max(0, W - L - R), height: H, fill: 'transparent' }, svg);
  hit.addEventListener('pointermove', (e: PointerEvent) => { const r = svg.getBoundingClientRect(), p = (e.clientX - r.left) * (W / r.width); show(Math.max(0, Math.min(n - 1, Math.round(((p - L) / (W - L - R)) * (n - 1))))); });
  hit.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(cur));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'ArrowLeft') { show(Math.max(0, cur - 1)); e.preventDefault(); } if (e.key === 'ArrowRight') { show(Math.min(n - 1, cur + 1)); e.preventDefault(); } });
}

function barPath(x: number, w: number, y0: number, y1: number, r: number) {
  const up = y1 < y0, h = Math.abs(y1 - y0); r = Math.min(r, h, w / 2);
  if (h < 0.5) return `M${x} ${y0}h${w}`;
  return up
    ? `M${x} ${y0}V${y1 + r}Q${x} ${y1} ${x + r} ${y1}H${x + w - r}Q${x + w} ${y1} ${x + w} ${y1 + r}V${y0}Z`
    : `M${x} ${y0}V${y1 - r}Q${x} ${y1} ${x + r} ${y1}H${x + w - r}Q${x + w} ${y1} ${x + w} ${y1 - r}V${y0}Z`;
}
function yearChart(box: HTMLElement, YEARS: any[]) {
  box.textContent = '';
  const W = box.clientWidth, H = box.clientHeight, L = 42, R = 6, T = 20, B = 46, n = YEARS.length;
  if (!n || W < 50) return;
  const all = [0]; YEARS.forEach((d) => all.push(d.me, d.bm));
  const amn = Math.min(...all), amx = Math.max(...all), pad = (amx - amn) * 0.14;
  const sc = nice(amn < 0 ? amn - pad : amn, amx > 0 ? amx + pad : amx, 4);
  const Y = (v: number) => T + (1 - (v - sc.lo) / (sc.hi - sc.lo)) * (H - T - B);
  const band = (W - L - R) / n, bw = Math.min(24, band * 0.22), gap = Math.max(16, Math.min(20, band * 0.2));
  const svg = S('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '年度收益对比：' + YEARS.map((d) => `${d.y}${d.ytd ? '（年初至今）' : ''} 我的 ${signed(d.me, 2, '%')}，沪深300 ${signed(d.bm, 2, '%')}`).join('；') }, box);
  const g = S('linearGradient', { id: 'yrg', x1: 0, x2: 0, y1: 0, y2: 1 }, S('defs', {}, svg));
  S('stop', { offset: 0, style: 'stop-color:var(--accent-2)' }, g); S('stop', { offset: 1, style: 'stop-color:var(--accent)' }, g);
  sc.ticks.forEach((t) => {
    S('line', { x1: L, x2: W - R, y1: Y(t), y2: Y(t), class: t === 0 ? 'zero' : 'gl' }, svg);
    S('text', { x: L - 10, y: Y(t) + 3.5, 'text-anchor': 'end', class: 'ax' }, svg).textContent = pct(t);
  });
  const tip = el('div', 'tip'), td = el('div', 'd'); tip.appendChild(td);
  const rows = [['var(--accent-2)', '我的'], ['var(--bench)', '沪深300']].map((k) => { const r = el('div', 'row'), i = el('i'); i.style.background = k[0]; r.appendChild(i); const b = el('b'); r.appendChild(b); r.appendChild(el('span', null, k[1])); tip.appendChild(r); return b; });
  const diff = el('div', 'd'); tip.appendChild(diff); box.appendChild(tip);
  YEARS.forEach((d, i) => {
    const cx = L + band * (i + 0.5), x1 = cx - bw - gap / 2, x2 = cx + gap / 2;
    const grp = S('g', { class: 'yb', tabindex: 0 }, svg);
    S('rect', { x: L + band * i, y: T, width: band, height: H - T, fill: 'transparent' }, grp);
    S('path', { d: barPath(x1, bw, Y(0), Y(d.me), 4), fill: 'url(#yrg)' }, grp);
    S('path', { d: barPath(x2, bw, Y(0), Y(d.bm), 4), style: 'fill:var(--bench)' }, grp);
    const ly = [d.me, d.bm].map((v: number) => (v >= 0 ? Y(v) - 6 : Y(v) + 14));
    if ((d.me >= 0) === (d.bm >= 0) && Math.abs(ly[0] - ly[1]) < 13 && bw + gap < 36) { const far = Math.abs(d.bm) >= Math.abs(d.me) ? 1 : 0; ly[far] += d.me >= 0 ? -12 : 12; }
    [[x1, d.me], [x2, d.bm]].forEach((b, k) => { S('text', { x: b[0] + bw / 2, y: ly[k], 'text-anchor': 'middle', class: 'vlab' + (k ? ' bm' : '') }, grp).textContent = signed(b[1], 1); });
    S('text', { x: cx, y: H - 24, 'text-anchor': 'middle', class: 'ylab' }, grp).textContent = d.y + (d.ytd ? '*' : '');
    const ex = d.me - d.bm;
    S('text', { x: cx, y: H - 7, 'text-anchor': 'middle', class: 'dlab ' + (ex >= 0 ? 'win' : 'lose') }, grp).textContent = (ex >= 0 ? '跑赢 ' : '跑输 ') + Math.abs(ex).toFixed(1);
    const show = () => {
      td.textContent = d.y + (d.ytd ? ' 年初至今' : ' 年');
      rows[0].textContent = signed(d.me, 2, '%'); rows[1].textContent = signed(d.bm, 2, '%');
      diff.textContent = (ex >= 0 ? '跑赢 ' : '跑输 ') + Math.abs(ex).toFixed(2) + ' 个百分点';
      tip.style.opacity = '1'; const tw = tip.offsetWidth; let left = cx + bw + 10; if (left + tw > W) left = cx - bw - tw - 10;
      tip.style.left = Math.max(0, left) + 'px'; tip.style.top = T + 'px'; grp.classList.add('on');
    };
    const hide = () => { tip.style.opacity = '0'; grp.classList.remove('on'); };
    grp.addEventListener('pointerenter', show); grp.addEventListener('pointerleave', hide);
    grp.addEventListener('focus', show); grp.addEventListener('blur', hide);
  });
}

/* ===== 渲染 ===== */
function countUp(e: HTMLElement, to: number, dec = 0) {
  const final = to.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  if (reduce) { e.textContent = final; return; }
  let t0 = 0;
  const f = (ts: number) => { if (!t0) t0 = ts; const k = Math.min(1, (ts - t0) / 900), v = to * (1 - Math.pow(1 - k, 3)); e.textContent = k < 1 ? v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) : final; if (k < 1) requestAnimationFrame(f); };
  requestAnimationFrame(f);
}
function big(parent: HTMLElement, v: number, dec: number, cls = 'big') {
  const d = el('div', cls); d.appendChild(el('span', 'cur', '¥')); const s = el('span'); d.appendChild(s); parent.appendChild(d); countUp(s, v, dec); return d;
}
function fact(box: HTMLElement, label: string, val: string, cls = '') {
  const d = el('div', null, label); d.appendChild(el('b', cls, val)); box.appendChild(d);
}

function renderHero(C: any, data: any) {
  $('h-asof').textContent = '截至 ' + data.asOf;
  const box = $('hero-body'); box.textContent = '';
  const h1 = el('h1', 'nw'); h1.setAttribute('aria-label', `总资产 ${fmt(C.totalAssets, 0)} 元`);
  h1.appendChild(el('span', 'cur', '¥')); const n = el('span'); h1.appendChild(n); box.appendChild(h1); countUp(n, Math.round(C.totalAssets));
  const sub = el('div', 'nw-sub');
  const item = (label: string, val: string, cls: string) => { const s = el('span', null, label); s.appendChild(el('b', cls, val)); sub.appendChild(s); };
  item('投资收益', syuan(C.profit), dir(C.profit));
  if (C.myX != null) item('年化', signed(C.myX, 1, '%'), dir(C.myX));
  if (isFinite(C.bmGain)) item('同样的钱买沪深300', syuan(C.bmGain, 0) + (C.bmX != null ? ` · 年化 ${signed(C.bmX, 1, '%')}` : ''), 'flat');
  box.appendChild(sub);
  const parts = [
    { k: 'pension', name: '养老金', v: C.accts.pension?.total || 0, c: 'var(--c1)', cls: 's1' },
    { k: 'invest', name: '理财账户', v: C.accts.invest?.total || 0, c: 'var(--c2)', cls: 's2' },
    { k: 'cash', name: '现金', v: data.cashAssets?.amount || 0, c: 'var(--c3)', cls: 's3' },
  ].filter((p) => p.v > 0);
  const tot = parts.reduce((s, p) => s + p.v, 0);
  const wrap = el('div', 'alloc3'), seg = el('div', 'seg'), leg = el('div', 'leg3');
  seg.setAttribute('role', 'img');
  seg.setAttribute('aria-label', '总资产构成：' + parts.map((p) => `${p.name} ${fmt(p.v, 0)} 元，占 ${(p.v / tot * 100).toFixed(1)}%`).join('；'));
  parts.forEach((p) => {
    const share = (p.v / tot) * 100;
    const b = el('div', p.cls); b.style.flex = `${share} 1 0`; b.tabIndex = 0; b.title = `${p.name} ${yuan(p.v)}（${share.toFixed(1)}%）`; seg.appendChild(b);
    const a = el('a'); a.href = p.k === 'cash' ? '#cash' : `#acct-${p.k}`;
    const i = el('i'); i.style.background = p.c; a.appendChild(i); a.appendChild(document.createTextNode(p.name + ' '));
    a.appendChild(el('b', null, yuan(p.v))); a.appendChild(el('span', null, share.toFixed(1) + '%')); leg.appendChild(a);
  });
  wrap.appendChild(seg); wrap.appendChild(leg); box.appendChild(wrap);
  const toc = el('nav', 'toc'); toc.setAttribute('aria-label', '本页目录');
  [['#perf', '收益走势'], ['#advice', '操作建议'], ['#acct-invest', '理财账户'], ['#acct-pension', '养老金'], ['#cash', '现金流']].forEach(([h, t]) => { const a = el('a', null, t); a.href = h; toc.appendChild(a); });
  box.appendChild(toc);
}

let PERF: any = null, perfBound = false;
const perfState = { mode: 'ret', range: 0 };
function drawPerf(animate: boolean) {
  if (!PERF) return;
  const { xs, ret, val, bm, C } = PERF, last = xs.length - 1;
  const box = $('ch'), ro = $('readout'), note = $('perf-note');
  const s = perfState.range ? Math.max(0, xs.length - perfState.range) : 0, cut = (a: any[]) => a.slice(s);
  ro.textContent = '';
  const key = (cls: string, label: string, v: string) => { const d = el('div'); d.appendChild(el('i', cls)); d.appendChild(document.createTextNode(label)); d.appendChild(el('b', null, v)); ro.appendChild(d); };
  if (perfState.mode === 'ret') {
    key('me', '我的', signed(ret[last], 1, '%')); key('bm', '沪深300', signed(bm[last], 1, '%'));
    lineChart(box, cut(xs), [{ name: '我的', v: cut(ret), main: true }, { name: '沪深300', v: cut(bm) }], { label: '累计收益（时间加权）', zero: true, left: 48, animate, fmt: (v: number) => signed(v, 1, '%'), tick: pct });
    note.textContent = `时间加权累计收益：加钱不会让曲线跳变，可以直接和指数比。每笔钱从进入那天起计：2026-10-31 以前按买入日，以后按每年 1 月 1 日存入日，没投出去的现金也算在内。沪深300 从 ${C.first} 起算，价格指数不含分红。`;
  } else {
    key('me', '计入市值', yuan(val[last]));
    lineChart(box, cut(xs), [{ name: '市值', v: cut(val), main: true }], { label: '计入统计的市值', area: true, zero: true, left: 44, animate, fmt: (v: number) => yuan(v), tick: wan });
    note.textContent = '计入统计的市值：2026-10-31 以前只含已买入的部分，之后含两个账户的全部资金（包括没投的现金）。加钱的月份市值会跳升，这是存入，不是收益。';
  }
}
function renderPerf(C: any) {
  const xs = C.series.map((s: any) => s.m), last = xs.length - 1;
  const ret = C.series.map((s: any) => Math.round(s.cum * 100) / 100), val = C.series.map((s: any) => s.v), bm = C.bmSeries.map((v: number) => Math.round(v * 100) / 100);
  PERF = { xs, ret, val, bm, C };
  const box = $('ch'), yb = $('ch-yr');
  if (!perfBound) {
    perfBound = true;
    const bind = (id: string, k: 'mode' | 'range') => document.querySelectorAll<HTMLButtonElement>(`#${id} button`).forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll(`#${id} button`).forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      (perfState as any)[k] = k === 'range' ? +b.dataset.range! : b.dataset.mode; drawPerf(true);
    }));
    bind('mode', 'mode'); bind('range', 'range');
    let w1 = 0, w2 = 0;
    new ResizeObserver(() => { if (box.clientWidth !== w1) { const first = !w1; w1 = box.clientWidth; if (!first) drawPerf(false); } }).observe(box);
    new ResizeObserver(() => { if (yb.clientWidth !== w2) { const first = !w2; w2 = yb.clientWidth; if (!first && PERF) yearChart(yb, PERF.C.years); } }).observe(yb);
  }
  drawPerf(true);
  yearChart(yb, C.years);
  const wins = C.years.filter((d: any) => d.me >= d.bm).length;
  $('yr-readout').textContent = '';
  const d = el('div'); d.appendChild(el('b', null, `${wins} / ${C.years.length}`)); d.appendChild(document.createTextNode('年跑赢沪深300')); $('yr-readout').appendChild(d);
  $('yr-note').textContent = `每年按时间加权计算，与沪深300 取同一时段：首年从 ${C.first} 首次买入起算，今年截至 ${C.asOf}。沪深300 为价格指数，不含分红。`;
  const tb = $('curve-table').querySelector('tbody')!; tb.textContent = '';
  for (let i = last; i >= 0; i--) { const tr = el('tr'); [xs[i], money(val[i], 0), signed(ret[i], 1, '%'), signed(bm[i], 1, '%')].forEach((t) => tr.appendChild(el('td', null, t))); tb.appendChild(tr); }
}

function renderAdvice(A: any, C: any, data: any) {
  $('adv-src').textContent = `依据 ${PUB.date || ''} 行情与长期策略 · 仅供参考，你来决定`;
  const sum = $('adv-sum'); sum.textContent = '';
  const inv = C.accts.invest, pen = C.accts.pension;
  const card = (color: string, title: string, amount: number, items: [string, string, string][]) => {
    const c = el('div', 'sum'), k = el('div', 'sum-k'), i = el('i'); i.style.background = color;
    k.appendChild(i); k.appendChild(document.createTextNode(`${title} · 待投 `)); k.appendChild(el('b', 'mono', yuan(amount))); c.appendChild(k);
    const ul = el('ul');
    items.forEach(([when, what, em]) => { const li = el('li'); li.appendChild(el('span', 'mono', when)); li.appendChild(document.createTextNode(what)); if (em) li.appendChild(el('em', null, em)); ul.appendChild(li); });
    c.appendChild(ul); sum.appendChild(c);
  };
  if (inv) {
    const now = A.list.filter((a: any) => a.now), next = A.list.filter((a: any) => a.next);
    const items: [string, string, string][] = [];
    if (now.length) items.push(['本月', now.map((a: any) => `${a.n} ¥${fmt(a.now, 0)}`).join(' · '), A.left >= 500 ? `余 ¥${fmt(A.left, 0)}` : '']);
    next.forEach((a: any) => items.push(['下月', `${a.n} ¥${fmt(a.next, 0)}`, a.cond || '']));
    if (!items.length) items.push(['现在', '暂时没有适合买的，现金先留着', '']);
    card('var(--c2)', inv.name, inv.cash || 0, items);
  }
  if (pen && A.pen) {
    const p = A.pen, prod = data.settings?.pensionProduct || '偏股养老基金';
    card('var(--c1)', pen.name, pen.cash || 0, [p.months ? [`${p.months} 个月`, `每月约 ¥${fmt(p.each, 0)} 定投${prod}`, p.why] : ['现在', '先不投', p.why]]);
  }
  const box = $('adv'); box.textContent = '';
  const MARK: Record<string, [string, string]> = { '1': ['+', '支持买入'], '0': ['·', '中性'], '-1': ['−', '不支持买入'] };
  A.list.forEach((d: any) => {
    const c = el('div', 'adv lv' + d.lv), h = el('div', 'adv-h'), nm = el('div');
    nm.appendChild(el('b', null, d.n)); nm.appendChild(el('small', null, inv.name)); h.appendChild(nm);
    const lv = el('div', 'lvl'); lv.setAttribute('role', 'img'); lv.setAttribute('aria-label', `建议强度 ${d.lv} / 5：${LV[d.lv]}`);
    for (let i = 1; i <= 5; i++) lv.appendChild(el('i', i <= d.lv ? 'on' : null));
    h.appendChild(lv); c.appendChild(h);
    const a = el('div', 'adv-act'); a.appendChild(el('span', null, d.act)); a.appendChild(el('em', null, d.amt)); c.appendChild(a);
    const ul = el('ul', 'sig');
    d.sig.forEach((s: any) => {
      const li = el('li'), m = MARK[String(s[2])];
      const b = el('span', 'mk s' + (s[2] > 0 ? 'p' : s[2] < 0 ? 'n' : 'z'), m[0]); b.title = m[1]; b.setAttribute('aria-label', m[1]);
      li.appendChild(b); li.appendChild(el('span', 'sl', s[0])); li.appendChild(el('span', 'st', s[1])); ul.appendChild(li);
    });
    c.appendChild(ul); c.appendChild(el('div', 'why', d.why)); box.appendChild(c);
  });
  const foot = $('adv-foot'); foot.textContent = '';
  const eb = el('span', 'eb', 'Schedule'); eb.style.letterSpacing = '.12em'; foot.appendChild(eb);
  const y = Number(C.asOf.slice(0, 4)), mo = Number(C.asOf.slice(5, 7));
  const rbY = mo > A.rb ? y + 1 : y;
  const it = (d: string, t: string) => { const s = el('span'); s.appendChild(el('b', 'mono', d)); s.appendChild(document.createTextNode(t)); foot.appendChild(s); };
  it(`${rbY}-${String(A.rb).padStart(2, '0')}`, ' 年度再平衡' + (A.goldOver > 0 ? `，黄金超配 ¥${fmt(A.goldOver, 0)}，看是否减回` : ''));
  if (A.win.start && !A.win.inside) it(A.win.start, ' 比特币减半窗口开启');
}

function renderAccount(key: string, C: any, A: any) {
  const a = C.accts[key], box = $('acct-' + key);
  box.textContent = '';
  if (!a) { box.hidden = true; return; }
  const withTarget = a.classes.some((c: any) => c.target != null);
  const head = el('div', 'head'), left = el('div');
  left.appendChild(el('div', 'eb', key === 'invest' ? 'Portfolio' : 'Pension'));
  const k = el('div', 'kicker'), i = el('i'); i.style.background = `var(--c${a.color || (key === 'pension' ? 1 : 2)})`; k.appendChild(i); k.appendChild(document.createTextNode(a.name)); left.appendChild(k);
  big(left, a.total, 2); head.appendChild(left);
  const facts = el('div', 'facts');
  fact(facts, '收益', syuan(a.pnl), dir(a.pnl));
  if (a.rate != null) fact(facts, a.rateLabel, signed(a.rate, 1, '%'), dir(a.rate));
  if (a.annual) fact(facts, `${a.year} 存入`, `${fmt(a.dep, 0)} / ${fmt(a.annual, 0)}${a.dep >= a.annual ? ' ✓' : ''}`);
  head.appendChild(facts); box.appendChild(head);

  // 分组持仓表
  const advBy: Record<string, any> = {};
  (A?.list || []).forEach((d: any) => { advBy[d.id] = d; });
  const scale = withTarget ? 50 : 100;
  const gt = el('div', 'gt'); gt.setAttribute('role', 'table'); gt.setAttribute('aria-label', a.name + '持仓');
  const hd = el('div', 'row hd'); hd.setAttribute('role', 'row');
  ['资产', withTarget ? '占比 · 目标' : '占比', '金额', '收益', '收益率', '近 1 月', '建议'].forEach((h, i) => { const c = el('div', i >= 2 && i <= 5 ? 'r' : i === 6 ? 'c-act' : '', h); c.setAttribute('role', 'columnheader'); hd.appendChild(c); });
  gt.appendChild(hd);
  const row = (o: any) => {
    const r = el('div', 'row ' + o.t); r.setAttribute('role', 'row');
    const nm = el('div', 'c-name');
    if (o.t === 'sub') nm.textContent = o.n; else { nm.appendChild(el('b', null, o.n)); if (o.s) nm.appendChild(el('small', null, o.s)); }
    r.appendChild(nm);
    const bc = el('div', 'c-bar' + (o.act == null ? ' nil' : ''));
    if (o.act != null) {
      const bar = el('div', 'bar'); bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', `${o.n} 占 ${o.act.toFixed(1)}%` + (o.tgt != null ? `，目标 ${o.tgt}%` : ''));
      if (o.act > 0) { const f = el('i', o.cash ? 'cash' : null); f.style.width = Math.min(100, (o.act / scale) * 100) + '%'; bar.appendChild(f); }
      if (o.tgt) { const t = el('b'); t.style.left = (o.tgt / scale) * 100 + '%'; bar.appendChild(t); }
      bc.appendChild(bar);
      const cap = el('div', 'bcap'); cap.appendChild(el('em', null, o.act.toFixed(1) + '%')); cap.appendChild(el('span', null, o.tgt != null ? `目标 ${o.tgt}%` : '')); bc.appendChild(cap);
    }
    r.appendChild(bc);
    ([['amt', '金额', o.amt, (v: number) => money(v), false], ['pnl', '收益', o.pnl, (v: number) => signed(v), true], ['ret', '收益率', o.ret, (v: number) => signed(v, 2, '%'), true], ['m1', '近 1 月', o.m1, (v: number) => signed(v, 2, '%'), true]] as any[]).forEach((c) => {
      const cell = el('div', `r c-${c[0]}` + (c[2] == null ? ' nil' : '') + (c[4] && c[2] != null ? ' ' + dir(c[2]) : ''));
      cell.setAttribute('data-l', c[1]); cell.setAttribute('role', 'cell');
      if (c[2] != null) cell.appendChild(document.createTextNode(c[3](c[2])));
      r.appendChild(cell);
    });
    const act = el('div', 'c-act' + (o.pill ? '' : ' nil'));
    if (o.gap) act.appendChild(el('div', 'g', o.gap));
    if (o.pill) act.appendChild(el('span', 'pill' + (o.go ? ' go' : ''), o.pill));
    r.appendChild(act); gt.appendChild(r);
  };
  a.classes.filter((c: any) => !c.hidden).forEach((c: any) => {
    const d = advBy[c.id];
    const gapTxt = c.target == null ? '' : Math.abs(c.gap) < a.total * 0.02 ? '已达标' : c.gap > 0 ? `差 ¥${fmt(c.gap, 0)}` : `超 ¥${fmt(-c.gap, 0)}`;
    row({ t: 'cls', n: c.name, s: c.note, act: c.act, tgt: c.target, amt: c.holdings.length ? c.amt : null, pnl: c.holdings.length ? c.pnl : null, ret: c.ret, m1: c.m1, gap: gapTxt, pill: d ? d.act : c.holdings.length ? '持有' : '', go: d ? d.lv >= 3 : false });
    if (c.holdings.length > 1) c.holdings.forEach((h: any) => row({ t: 'sub', n: h.name, amt: h.amount, pnl: h.pnl, ret: h.ret, m1: h.m1 }));
  });
  if (a.cash) {
    let pill = '待投', go = false;
    if (key === 'invest' && A) { const used = A.list.reduce((s: number, d: any) => s + (d.now || 0), 0); pill = used ? `本月用 ¥${fmt(used, 0)}` : '先留着'; go = used > 0; }
    if (key === 'pension' && A?.pen) { pill = A.pen.months ? `分 ${A.pen.months} 个月投入` : '先不投'; go = !!A.pen.months; }
    row({ t: 'cls', cash: true, n: a.cashName || '待投现金', s: a.cashNote, act: (a.cash / a.total) * 100, amt: a.cash, pill, go });
  }
  (a.extra || []).forEach((x: any) => row({ t: 'fee', n: x.name, s: x.note, pnl: x.pnl }));
  row({ t: 'total', n: '合计', amt: a.total, pnl: a.pnl });
  box.appendChild(gt);
  const keys = el('div', 'gkeys');
  const kk = (cls: string, t: string) => { const s = el('span'); s.appendChild(el('i', cls)); s.appendChild(document.createTextNode(t)); keys.appendChild(s); };
  kk('k1', withTarget ? '当前占比（占账户总值）' : '占账户总值'); if (withTarget) kk('k2', '目标'); kk('k3', '现金');
  keys.appendChild(el('span', null, '产品收益率 = 持有收益 ÷ 成本；账户收益看右上角'));
  box.appendChild(keys);
  // 折叠：历年收益与交易记录
  const trades = a.trades || [];
  if (trades.length || a.yearly) {
    const det = el('details', 'more');
    det.appendChild(el('summary', null, (a.yearly ? '历年收益与' : '') + `交易记录（${trades.length} 条）`));
    const inner = el('div', 'more-in' + (a.yearly ? ' more-grid' : ''));
    if (a.yearly) {
      const w = el('div'); w.appendChild(el('div', 'sub-h', '历年收益'));
      const t = el('table', 'yr'), th = el('thead'), tr = el('tr'); tr.appendChild(el('th', null, '产品'));
      a.yearly.cols.forEach((c: string) => tr.appendChild(el('th', null, c))); th.appendChild(tr); t.appendChild(th);
      const tb = el('tbody');
      a.yearly.rows.forEach((r: any[]) => { const tr2 = el('tr'); tr2.appendChild(el('td', null, r[0])); r.slice(1).forEach((v) => tr2.appendChild(el('td', v == null ? 'muted' : dir(v), v == null ? '—' : signed(v, 2, '%')))); tb.appendChild(tr2); });
      t.appendChild(tb); w.appendChild(t); inner.appendChild(w);
    }
    const w2 = el('div'); if (a.yearly) w2.appendChild(el('div', 'sub-h', '交易记录'));
    const t2 = el('table', 'trades'), th2 = el('thead'), tr3 = el('tr');
    ['日期', '标的', '买卖', '金额'].forEach((h) => tr3.appendChild(el('th', null, h))); th2.appendChild(tr3); t2.appendChild(th2);
    const tb2 = el('tbody');
    trades.forEach((x: any) => {
      const tr4 = el('tr', x.muted ? 'gone' : null); tr4.appendChild(el('td', null, x.date));
      const nm = el('td', null, x.name); if (x.note) nm.appendChild(el('small', null, x.note)); tr4.appendChild(nm);
      tr4.appendChild(el('td', null, x.side || '')); tr4.appendChild(el('td', null, x.amount)); tb2.appendChild(tr4);
    });
    t2.appendChild(tb2); w2.appendChild(t2); inner.appendChild(w2); det.appendChild(inner); box.appendChild(det);
  }
}

function renderCash(data: any) {
  const ca = data.cashAssets, sp = data.spending;
  const box = $('cash');
  if (!ca && !sp) { box.hidden = true; return; }
  $('spend-month').textContent = sp?.month || '';
  const st = $('cash-stats'); st.textContent = '';
  const stat = (label: string, v: number, dec: number, sub: (d: HTMLElement) => void, dot = false) => {
    const d = el('div'), l = el('div', 'l');
    if (dot) { const i = el('i'); Object.assign(i.style, { display: 'inline-block', width: '8px', height: '8px', borderRadius: '2px', background: 'var(--c3)', marginRight: '8px' }); l.appendChild(i); }
    l.appendChild(document.createTextNode(label)); d.appendChild(l);
    const vv = el('div', 'v'); vv.appendChild(el('span', 'cur', '¥')); const n = el('span'); vv.appendChild(n); d.appendChild(vv); countUp(n, v, dec);
    sub(d); st.appendChild(d);
  };
  if (ca) stat('现金资产', ca.amount, 0, (d) => { const s = el('div', 's'); if (ca.prev != null) { s.appendChild(document.createTextNode(`较 ${ca.prevLabel || '上月'} `)); s.appendChild(el('b', dir(ca.amount - ca.prev), syuan(ca.amount - ca.prev, 0))); } if (ca.asOf) s.appendChild(document.createTextNode(` · 余额日期 ${ca.asOf}`)); d.appendChild(s); }, true);
  if (sp) {
    const used = sp.budget ? (sp.total / sp.budget) * 100 : null;
    stat('本月支出', sp.total, 2, (d) => {
      if (used != null) { const m = el('div', 'meter'); m.setAttribute('role', 'img'); m.setAttribute('aria-label', `已用预算 ${used.toFixed(1)}%`); const i = el('i'); i.style.width = Math.min(100, used) + '%'; m.appendChild(i); d.appendChild(m); }
      const s = el('div', 's'); if (sp.budget) { s.appendChild(document.createTextNode('预算 ')); s.appendChild(el('b', null, yuan(sp.budget))); s.appendChild(document.createTextNode(` · 已用 `)); s.appendChild(el('b', null, used!.toFixed(1) + '%')); }
      if (sp.count) s.appendChild(document.createTextNode(` · ${sp.count} 笔`)); d.appendChild(s);
    });
    if (sp.budget) stat('本月结余', sp.budget - sp.total, 2, (d) => { const s = el('div', 's'); s.appendChild(document.createTextNode('占预算 ')); s.appendChild(el('b', null, ((1 - sp.total / sp.budget) * 100).toFixed(1) + '%')); d.appendChild(s); });
    const cats = [...(sp.cats || [])].sort((a: any, b: any) => b[1] - a[1]), max = cats[0]?.[1] || 1;
    const fill = (ul: HTMLElement, list: any[]) => { ul.textContent = ''; list.forEach((c) => { const li = el('li'); li.appendChild(el('span', null, c[0])); const w = el('div'), b = el('div', 'b'); b.style.width = (c[1] / max) * 100 + '%'; w.appendChild(b); li.appendChild(w); li.appendChild(el('span', 'a', money(c[1]))); li.appendChild(el('span', 'p', ((c[1] / sp.total) * 100).toFixed(1) + '%')); ul.appendChild(li); }); };
    fill($('cats'), cats.slice(0, 3));
    const rest = cats.slice(3);
    if (rest.length) { fill($('cats-more'), rest); $('cats-more-sum').textContent = `其余 ${rest.length} 类 · ${yuan(rest.reduce((s: number, c: any) => s + c[1], 0), 2)}`; } else ($('cats-more-box') as HTMLElement).hidden = true;
  }
}

let lit = false;
function spotlight() {
  if (lit) return; lit = true;
  document.querySelectorAll<HTMLElement>('#app .card').forEach((c) => {
    c.addEventListener('pointermove', (e) => { const r = c.getBoundingClientRect(); c.style.setProperty('--mx', e.clientX - r.left + 'px'); c.style.setProperty('--my', e.clientY - r.top + 'px'); });
    c.addEventListener('pointerleave', () => { c.style.setProperty('--mx', '-999px'); c.style.setProperty('--my', '-999px'); });
  });
}

function render(data: any, meta: any) {
  const C = compute(data);
  const A = advise(C, data);
  $('gate').hidden = true; $('app').hidden = false;
  renderHero(C, data);
  renderPerf(C);
  if (A) renderAdvice(A, C, data); else $('advice').hidden = true;
  renderAccount('invest', C, A);
  renderAccount('pension', C, A);
  renderCash(data);
  spotlight();
  $('tb-info').textContent = `数据截至 ${data.asOf}` + (meta?.uploadedAt ? ` · 上传于 ${meta.uploadedAt.slice(0, 16)}（UTC）` : '') + (data.source ? ` · ${data.source}` : '');
  // 页面数据会被粒子层读取位置，渲染完通知一次尺寸变化
  window.dispatchEvent(new Event('resize'));
}

/* ===== 登录与导入 ===== */
function gate(state: 'login' | 'empty' | 'off' | 'error', text?: string) {
  $('app').hidden = true; $('gate').hidden = false;
  const form = $('login-form'), imp = $('import-box');
  form.hidden = state !== 'login'; imp.hidden = state !== 'empty';
  $('gate-title').textContent = { login: '输入口令', empty: '导入数据', off: '私人页还没开启', error: '出错了' }[state];
  $('gate-text').textContent = text || { login: '这一页只有你能看。口令只在服务器上校验，登录后 7 天内不用再输。', empty: '已经登录。', off: '需要先在 Cloudflare 里设置口令（ME_PASSWORD），再重新部署一次。', error: '请稍后刷新重试。' }[state];
  if (state === 'login') setTimeout(() => ($('pw') as HTMLInputElement).focus(), 50);
}
async function load() {
  let r: Response;
  try { r = await fetch('/api/me/data', { credentials: 'same-origin', cache: 'no-store' }); } catch { return gate('error', '网络不通，请稍后刷新。'); }
  if (r.status === 401) return gate('login');
  if (r.status === 503) return gate('off');
  if (!r.ok) return gate('error', `服务器返回 ${r.status}`);
  const j = await r.json();
  if (!j.data) return gate('empty');
  try { render(j.data, j); } catch (e) { console.error(e); gate('error', '数据格式有问题：' + (e as Error).message); }
}
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('pw') as HTMLInputElement, btn = $('login-btn') as HTMLButtonElement, msg = $('login-msg');
  btn.disabled = true; msg.className = 'msg'; msg.textContent = '校验中…';
  try {
    const r = await fetch('/api/me/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw.value }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { msg.className = 'msg err'; msg.textContent = j.error || '登录失败'; return; }
    pw.value = ''; msg.textContent = ''; await load();
  } catch { msg.className = 'msg err'; msg.textContent = '网络不通'; } finally { btn.disabled = false; }
});
async function upload(file: File, msg: HTMLElement) {
  msg.className = 'msg'; msg.textContent = '上传中…';
  let text = '';
  try { text = await file.text(); JSON.parse(text); } catch { msg.className = 'msg err'; msg.textContent = '这不是合法的 JSON 文件'; return; }
  const r = await fetch('/api/me/data', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: text });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { msg.className = 'msg err'; msg.textContent = j.error || `上传失败（${r.status}）`; if (r.status === 401) gate('login'); return; }
  msg.className = 'msg ok'; msg.textContent = `已导入 ${j.asOf} 的数据`;
  await load();
}
$('file-first').addEventListener('change', (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) upload(f, $('first-msg')); });
$('file-update').addEventListener('change', (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) upload(f, $('tb-msg')); (e.target as HTMLInputElement).value = ''; });
$('logout').addEventListener('click', async () => { await fetch('/api/me/login', { method: 'DELETE', credentials: 'same-origin' }).catch(() => {}); location.reload(); });

load();
