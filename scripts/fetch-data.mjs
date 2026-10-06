// 抓取行情并写入 src/data/markets.json。
//   node scripts/fetch-data.mjs          从 Yahoo Finance 抓取（需要联网）
//   node scripts/fetch-data.mjs --demo   生成示例数据（离线预览用）
// 单个品种抓取失败时，保留它上一次的数据，不会让整个看板空掉。
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'src/data/markets.config.json');
const outPath = path.join(root, 'src/data/markets.json');
const demo = process.argv.includes('--demo');

const config = JSON.parse(await readFile(configPath, 'utf8'));
let previous = { series: {} };
try { previous = JSON.parse(await readFile(outPath, 'utf8')); } catch {}

const fmtDate = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

async function fromYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3y&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (personal-website data fetcher)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(json?.chart?.error?.description || 'empty result');
  const closes = r.indicators.quote[0].close;
  const points = [];
  r.timestamp.forEach((ts, i) => {
    const v = closes[i];
    if (typeof v === 'number' && Number.isFinite(v)) points.push([fmtDate(ts), Math.round(v * 1e4) / 1e4]);
  });
  if (points.length < 20) throw new Error('too few points');
  return points;
}

// 确定性的伪随机，让示例数据每次生成都一样
function demoSeries(seed, start, drift, vol) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const pts = [];
  const end = new Date('2026-10-05T00:00:00Z');
  let v = start;
  for (let i = 3 * 365; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86400000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    v = Math.max(start * 0.2, v * (1 + drift + (rnd() - 0.5) * vol));
    pts.push([d.toISOString().slice(0, 10), Math.round(v * 1e4) / 1e4]);
  }
  return pts;
}
const demoParams = {
  sh000001: [11, 3000, 0.0004, 0.016], sh000300: [13, 3500, 0.0004, 0.018], sz399006: [17, 1900, 0.0003, 0.026],
  us10y: [19, 4.2, 0.0001, 0.02], spx: [23, 4500, 0.0006, 0.014], ndx: [29, 15500, 0.0007, 0.018],
  gold: [31, 2000, 0.0007, 0.012], usdcny: [37, 7.1, 0.00002, 0.003], btc: [41, 9000, 0.0016, 0.04],
};

const out = { updatedAt: new Date().toISOString(), demo, series: {} };
let failed = 0;
for (const s of config.series) {
  try {
    let points;
    if (demo) { const [seed, st, dr, vo] = demoParams[s.id]; points = demoSeries(seed, st, dr, vo); }
    else points = await fromYahoo(s.symbol);
    out.series[s.id] = { points };
    console.log(`ok   ${s.id} (${points.length} points)`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${s.id}: ${e.message}`);
    if (previous.series[s.id]) out.series[s.id] = previous.series[s.id];
  }
  if (!demo) await new Promise((r) => setTimeout(r, 400));
}
if (!Object.keys(out.series).length) { console.error('no data at all, not writing'); process.exit(1); }
if (!demo && previous.demo === false && failed === 0) out.demo = false;
await writeFile(outPath, JSON.stringify(out) + '\n');
console.log(`wrote ${outPath}${failed ? ` (${failed} failed, kept old data)` : ''}`);
