import config from './data/markets.config.json';
import data from './data/markets.json';

export type Point = [string, number];
export interface Quote {
  id: string; name: string; category: string; decimals: number; prefix: string; suffix: string; kind: string;
  last: number; change: number; changeText: string; dir: 'up' | 'down' | 'flat'; date: string; points: Point[];
}

export const categories = config.categories;
export const updatedAt: string = (data as any).updatedAt;
export const isDemo: boolean = !!(data as any).demo;

export function fmt(v: number, decimals: number) {
  return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function quotes(): Quote[] {
  const out: Quote[] = [];
  for (const s of config.series as any[]) {
    const points: Point[] = (data as any).series[s.id]?.points;
    if (!points || points.length < 2) continue;
    const last = points[points.length - 1][1];
    const prev = points[points.length - 2][1];
    let changeText: string;
    let change: number;
    if (s.kind === 'yield') { change = (last - prev) * 100; changeText = `${Math.abs(change).toFixed(1)} bp`; }
    else { change = ((last - prev) / prev) * 100; changeText = `${Math.abs(change).toFixed(2)}%`; }
    out.push({
      id: s.id, name: s.name, category: s.category, decimals: s.decimals ?? 2,
      prefix: s.prefix ?? '', suffix: s.suffix ?? '', kind: s.kind,
      last, change, changeText, dir: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
      date: points[points.length - 1][0], points,
    });
  }
  return out;
}

export const arrow = (d: Quote['dir']) => (d === 'up' ? '▲' : d === 'down' ? '▼' : '–');
