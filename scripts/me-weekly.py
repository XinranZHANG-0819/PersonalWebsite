#!/usr/bin/env python3
"""私人资产页每周更新：从站点读最新一份数据 → 按最新净值重算各产品市值 → 上传。

脚本本身不含任何个人数据：基金代码、份额、成本都在站点 D1 里（holdings 的 code / units / cost 字段）。
认证：请求头 Authorization: Bearer <ME_UPLOAD_TOKEN>。在 Claude 的云端环境里由网络代理注入，
本地运行时可以设环境变量 ME_UPLOAD_TOKEN。

用法：
  python3 scripts/me-weekly.py            # 读取、重算、上传
  python3 scripts/me-weekly.py --dry-run  # 只打印结果，不上传
  python3 scripts/me-weekly.py --in a.json --out b.json   # 离线：读本地文件、写本地文件

新交易（买入、卖出、新存入）不会自动出现，需要先手动记进数据里；这个脚本只负责按净值重估。
"""
import argparse, datetime as dt, json, os, re, ssl, sys, urllib.request

SITE = os.environ.get('ME_SITE', 'https://xinran.wiki')
CA = '/root/.ccr/ca-bundle.crt'
CTX = ssl.create_default_context(cafile=CA) if os.path.exists(CA) else ssl.create_default_context()
TZ = dt.timezone(dt.timedelta(hours=8))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def http(url, method='GET', body=None, headers=None):
    h = {'User-Agent': 'Mozilla/5.0 (personal-website weekly update)'}
    h.update(headers or {})
    req = urllib.request.Request(url, data=body, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=40, context=CTX) as r:
        return r.status, r.read()


def auth():
    # 在云端由代理替换成真实令牌；本地用环境变量
    return {'Authorization': 'Bearer ' + os.environ.get('ME_UPLOAD_TOKEN', 'injected-by-proxy')}


_nav = {}
def nav(code):
    """天天基金的净值历史：[(日期, 单位净值), ...]，按日期升序。"""
    if code not in _nav:
        _, raw = http(f'https://fund.eastmoney.com/pingzhongdata/{code}.js', headers={'Referer': 'https://fund.eastmoney.com/'})
        m = re.search(r'Data_netWorthTrend\s*=\s*(\[.*?\]);', raw.decode('utf-8', 'ignore'), re.S)
        if not m:
            raise RuntimeError(f'{code}: 拿不到净值')
        _nav[code] = [(dt.datetime.fromtimestamp(x['x'] / 1000, TZ).strftime('%Y-%m-%d'), float(x['y'])) for x in json.loads(m.group(1))]
    return _nav[code]


def on(series, day):
    best = None
    for d, v in series:
        if d <= day:
            best = (d, v)
        else:
            break
    return best


def first_on_or_after(series, day):
    for d, v in series:
        if d >= day:
            return (d, v)
    return None


def shift(day, days):
    return (dt.date.fromisoformat(day) - dt.timedelta(days=days)).isoformat()


r2 = lambda v: round(v + 1e-9, 2)


def revalue(data, markets):
    notes = []
    for h in data['holdings']:
        if h.get('code') and h.get('units') is not None:
            s = nav(h['code'])
            if h.get('pending'):  # 申购确认中：等到申购日净值出来，按（金额 ÷ (1+费率)）÷ 当日净值 重算份额
                p = first_on_or_after(s, h['pending'])
                if p:
                    h['units'] = round(h['cost'] / (1 + h.get('fee', 0)) / p[1], 4)
                    h.pop('pending', None)
                    if h.get('note', '').startswith('确认中'):
                        h.pop('note', None)
                    notes.append(f"{h['name']}：按 {p[0]} 净值 {p[1]} 确认份额 {h['units']}")
                else:
                    notes.append(f"{h['name']}：申购净值还没出，先按成本计")
                    h.update(amount=h['cost'], pnl=0.0, ret=0.0)
                    continue
            d, v = s[-1]
            h['amount'] = r2(h['units'] * v)
            h['navDate'] = d
            m = on(s, shift(d, 30))
            h['m1'] = round((v / m[1] - 1) * 100, 2) if m else None
        elif h.get('proxy', {}).get('type') == 'ndx×usdcny':  # QQQon：没有净值源，按纳指100 × 汇率估算
            px = h['proxy']
            S = markets['series']
            n1, f1 = S['ndx']['points'][-1], S['usdcny']['points'][-1]
            n0, f0 = on(S['ndx']['points'], px['date']), on(S['usdcny']['points'], px['date'])
            nm, fm = on(S['ndx']['points'], shift(n1[0], 30)), on(S['usdcny']['points'], shift(n1[0], 30))
            h['amount'] = r2(px['base'] * (n1[1] / n0[1]) * (f1[1] / f0[1]))
            h['m1'] = round(((n1[1] / nm[1]) * (f1[1] / fm[1]) - 1) * 100, 2)
            h['navDate'] = n1[0]
            px.update(base=h['amount'], date=n1[0])
        else:
            continue
        h['pnl'] = r2(h['amount'] - h['cost'])
        h['ret'] = round(h['pnl'] / h['cost'] * 100, 2) if h['cost'] else None

    # 恒等式：各产品收益 + extra = 账户总值 − 计入的资金（flows 之和）。差额记到标了 plug 的那一行（手续费、利息等）
    totals = {}
    for k, a in data['accounts'].items():
        hs = [h for h in data['holdings'] if h['account'] == k]
        total = sum(h['amount'] for h in hs) + a.get('cash', 0)
        flows = sum(f['amount'] for f in data['flows'] if f.get('account') == k)
        plug = [x for x in a.get('extra', []) if x.get('plug')]
        if plug:
            fixed = sum(x['pnl'] for x in a.get('extra', []) if not x.get('plug'))
            plug[0]['pnl'] = r2((total - flows) - sum(h['pnl'] for h in hs) - fixed)
        totals[k] = r2(total)

    dates = [h['navDate'] for h in data['holdings'] if h.get('navDate')]
    data['asOf'] = max(dates) if dates else data['asOf']
    month, total = data['asOf'][:7], r2(sum(totals.values()))
    if data['monthly'] and data['monthly'][-1][0] == month:
        data['monthly'][-1][1] = total
    else:
        data['monthly'].append([month, total])
    lag = sorted({h['navDate'] for h in data['holdings'] if h.get('navDate') and h['navDate'] < data['asOf']})
    data['source'] = f"{dt.datetime.now(TZ):%Y-%m-%d} 自动更新；净值截至 {data['asOf']}" + (f"（部分基金净值滞后，最早 {lag[0]}）" if lag else '') + '；QQQon 按纳指100和汇率估算'
    return totals, total, notes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--in', dest='inp')
    ap.add_argument('--out')
    a = ap.parse_args()
    if a.inp:
        data = json.load(open(a.inp, encoding='utf-8'))
    else:
        st, raw = http(SITE + '/api/me/data', headers=auth())
        data = json.loads(raw)['data']
    before = {k: r2(sum(h['amount'] for h in data['holdings'] if h['account'] == k) + v.get('cash', 0)) for k, v in data['accounts'].items()}
    markets = json.load(open(os.path.join(ROOT, 'src/data/markets.json'), encoding='utf-8'))
    totals, total, notes = revalue(data, markets)
    for k in totals:
        chg = totals[k] / before[k] - 1 if before[k] else 0
        print(f"{data['accounts'][k]['name']}：{before[k]:,.2f} → {totals[k]:,.2f}（{chg:+.2%}）")
        if abs(chg) > 0.15:
            sys.exit(f'变化超过 15%，不上传，请人工检查：{k}')
    for n in notes:
        print(' ·', n)
    print(f"截至 {data['asOf']}，两个账户合计 {total:,.2f}")
    if a.out:
        json.dump(data, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    if a.dry_run or a.inp:
        return
    st, raw = http(SITE + '/api/me/data', 'PUT', json.dumps(data, ensure_ascii=False).encode(), {**auth(), 'content-type': 'application/json'})
    print('上传', st, raw.decode()[:200])


if __name__ == '__main__':
    main()
