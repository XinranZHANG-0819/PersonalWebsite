"""抓取 A 股与国内债的补充数据，写入 src/data/indicators.json（Yahoo 里没有这些）。

- pb300：沪深300 市净率的 10 年滚动分位（AkShare / 乐咕乐股）
- cn10y：中国国债 10 年期收益率（AkShare / 东方财富）
- cbond：中债新综合指数（财富指数，AkShare / 中央结算公司）
- excape：超额 CAPE 收益率，TIPS 版 ECY = 1/CAPE − 10 年 TIPS 收益率（FRED DFII10）

每个序列单独抓取，失败时保留它上一次的数据，不影响其他序列。
"""
import json, sys, pathlib
import pandas as pd

root = pathlib.Path(__file__).resolve().parent.parent
out = root / "src/data/indicators.json"
KEEP = pd.Timedelta(days=10 * 366 + 10)
DAILY_KEEP = pd.Timedelta(days=3 * 366)

try:
    store = json.loads(out.read_text(encoding="utf-8"))
    store.setdefault("series", {})
except Exception:
    store = {"updatedAt": None, "series": {}}

import akshare as ak


def to_points(s: pd.Series, nd: int):
    """保留近 10 年；日度数据里，近 3 年留日线，更早的按周取最后一个点。月度数据原样保留。"""
    s = s[s.index >= s.index[-1] - KEEP]
    gap = s.index.to_series().diff().dt.days.median()
    if gap is not None and gap < 15:
        cut = s.index[-1] - DAILY_KEEP
        old, new = s[s.index < cut], s[s.index >= cut]
        if len(old):
            wk = old.index.to_series().dt.to_period("W")
            old = old[~wk.duplicated(keep="last")]   # 每周只留最后一个交易日，日期保持真实
        s = pd.concat([old, new])
    return [[d.strftime("%Y-%m-%d"), round(float(v), nd)] for d, v in s.items()]


def _parse_pb(df: pd.DataFrame) -> pd.Series:
    print("  columns:", list(df.columns), "rows:", len(df), "range:", df.iloc[0, 0], "→", df.iloc[-1, 0])
    date_col = "日期" if "日期" in df.columns else df.columns[0]
    cands = [c for c in df.columns if "市净率" in str(c) and not any(k in str(c) for k in ("等权", "中位", "分位", "平均"))]
    pb_col = cands[0] if cands else df.columns[1]
    return pd.Series(pd.to_numeric(df[pb_col], errors="coerce").values, index=pd.to_datetime(df[date_col])).sort_index().dropna()


def pb300():
    """沪深300 市净率的 10 年滚动分位。数据源可能是日度，也可能是月度，窗口按频率换算成 10 年。"""
    s = _parse_pb(ak.stock_index_pb_lg(symbol="沪深300"))
    gap = s.index.to_series().diff().dt.days.median()
    window = 120 if gap > 15 else 2430   # 月度 120 个点，日度约 2430 个交易日
    print(f"  median gap {gap} days → window {window} points")
    if len(s) < window:
        raise RuntimeError(f"history too short: {len(s)} < {window}")
    pct = s.rolling(window, min_periods=window).apply(lambda w: (w <= w[-1]).mean() * 100, raw=True).dropna()
    return to_points(pct, 1)


def cn10y():
    """中国国债 10 年期收益率。AkShare 1.20.41+ 把 bond_zh_us_rate 改名为
    bond_zh_us_yield_em，旧接口已失效（2026-11-12 起停更就是这个原因）。"""
    df = ak.bond_zh_us_yield_em()
    print("  columns:", list(df.columns), "rows:", len(df), "range:", df.iloc[0, 0], "→", df.iloc[-1, 0])
    col = next(c for c in df.columns if "10年" in str(c) and "国债" in str(c))
    date_col = "日期" if "日期" in df.columns else df.columns[0]
    s = pd.Series(pd.to_numeric(df[col], errors="coerce").values, index=pd.to_datetime(df[date_col])).sort_index().dropna()
    if len(s) < 100:
        raise RuntimeError(f"too few points: {len(s)}")
    if s.index[-1] < pd.Timestamp.now() - pd.Timedelta(days=10):
        raise RuntimeError(f"stale: last {s.index[-1].date()}")
    return to_points(s, 4)


def cbond():
    # 中债新综合指数（财富指数，含利息再投资，反映债券的总回报）
    df = ak.bond_new_composite_index_cbond(indicator="财富", period="总值")
    s = pd.Series(df.iloc[:, 1].astype(float).values, index=pd.to_datetime(df.iloc[:, 0])).sort_index().dropna()
    if len(s) < 100:
        raise RuntimeError(f"too few points: {len(s)}")
    return to_points(s, 4)


def _http(url: str) -> bytes:
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (personal-website data fetcher)"})
    return urllib.request.urlopen(req, timeout=60).read()


def _month_end(idx) -> pd.DatetimeIndex:
    return pd.DatetimeIndex(pd.to_datetime(idx)) + pd.offsets.MonthEnd(0)


def _multpl_cape() -> pd.Series:
    import io
    html = _http("https://www.multpl.com/shiller-pe/table/by-month").decode("utf-8", "ignore")
    t = pd.read_html(io.StringIO(html))[0]
    t.columns = ["date", "v"]
    d = pd.to_datetime(t["date"], errors="coerce")
    v = pd.to_numeric(t["v"].astype(str).str.extract(r"([\d.]+)")[0], errors="coerce")
    ser = pd.Series(v.values, index=_month_end(d.fillna(pd.Timestamp("1900-01-31")))).dropna()
    ser = ser[ser.index > "1950-01-01"].sort_index()
    # 当月内有多个点（如 10 月 1 日和 10 月 30 日）都会落到当月月末，留最新一个
    return ser[~ser.index.duplicated(keep="last")]


def _dfii10_me() -> pd.Series:
    """10 年 TIPS 收益率（FRED DFII10，日度）取月末值。
    fredgraph.csv 需带浏览器 User-Agent，否则不给数据。"""
    import io
    raw = _http("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFII10")
    df = pd.read_csv(io.StringIO(raw.decode("utf-8", "ignore")))
    date_col, val_col = df.columns[0], df.columns[1]
    s = pd.Series(pd.to_numeric(df[val_col], errors="coerce").values,
                  index=pd.to_datetime(df[date_col])).sort_index().dropna()
    if len(s) < 60:
        raise RuntimeError(f"DFII10 too few points: {len(s)}")
    me = s.resample("ME").last().dropna()
    me.index = _month_end(me.index)
    return me


def excape_current():
    """超额 CAPE 收益率（TIPS 版 ECY）= 1/CAPE − 10 年 TIPS 收益率。
    CAPE 用 multpl（标普 500 席勒市盈率，月度，实时更新）；TIPS 收益率
    用 FRED DFII10 月末值。2026-11-26 起替代席勒原版。"""
    cape = _multpl_cape()
    tips = _dfii10_me()
    print("  cape", cape.index[-1].date(), cape.iloc[-1], "| dfii10", tips.index[-1].date(), tips.iloc[-1])
    df = pd.concat([cape.rename("cape"), tips.rename("tips")], axis=1).sort_index()
    df["tips"] = df["tips"].ffill(limit=1)   # TIPS 公布略晚，向前补最多 1 个月
    ex = ((100 / df["cape"]) - df["tips"]).dropna()
    if len(ex) < 60:
        raise RuntimeError(f"too few points: {len(ex)}")
    if ex.index[-1] < pd.Timestamp.now() - pd.Timedelta(days=120):
        raise RuntimeError(f"stale: last {ex.index[-1].date()}")
    today = pd.Timestamp.now().normalize()
    ex.index = pd.DatetimeIndex([min(d, today) for d in ex.index])   # 当月的点按月底标注会晚于今天，压到今天
    return to_points(ex, 2)


def excape():
    # 注意：不要再把旧的席勒版 excape 当兜底。耶鲁 Shiller 表最后一次更新是
    # 2023-09，兜底会把序列悄悄倒回 2023 年，页面默认 1 年视图里这条线
    # 因超出窗口被裁掉、看起来就是“没有了”，而其他序列照常更新、毫无报错。
    # 新路径失败时宁可保留上一次的近期数据（脚本主循环的失败保留逻辑），
    # 并在日志里留下 FAIL excape，便于发现。multpl 在个别网络环境下连不上
    # 时同样如此（fail-soft，不静默写旧数据当新数据）。
    return excape_current()


def patch_markets():
    """沪深300、创业板指、上证指数：Yahoo 偶尔只返回很少的点，用新浪的日线覆盖，保证 A 股指数是完整的。
    AkShare 1.20.44+ 把 stock_zh_index_daily 改名为 index_zh_daily_sina，旧接口已失效
    （2026-11-13 起停更就是这个原因）。新数据与旧序列按日期合并，历史不丢失。"""
    mpath = root / "src/data/markets.json"
    m = json.loads(mpath.read_text(encoding="utf-8"))
    changed = 0
    for sid, sym in (("sh000300", "sh000300"), ("sz399006", "sz399006"), ("sh000001", "sh000001")):
        try:
            df = ak.index_zh_daily_sina(symbol=sym)
            ser = pd.Series(df["close"].astype(float).values, index=pd.to_datetime(df["date"])).sort_index().dropna()
            if ser.index[-1] < pd.Timestamp.now() - pd.Timedelta(days=10):
                raise RuntimeError(f"stale: last {ser.index[-1].date()}")
            old = {d: float(v) for d, v in m["series"][sid]["points"]}
            merged = {**old, **{d.strftime("%Y-%m-%d"): float(v) for d, v in ser.items()}}
            mser = pd.Series(merged)
            mser.index = pd.to_datetime(mser.index)
            mser = mser.sort_index()
            pts = to_points(mser, 4)
            if len(pts) < 200:
                raise RuntimeError(f"too few points: {len(pts)}")
            m["series"][sid] = {"points": pts}
            changed += 1
            print(f"ok   {sid} via sina ({len(pts)} points, last {pts[-1]})")
        except Exception as e:
            print(f"FAIL {sid} via sina: {e}", file=sys.stderr)
    if changed:
        mpath.write_text(json.dumps(m, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def _series_last(points):
    """取序列最后一个 [date, value]，没有则返回 None。"""
    if not points:
        return None
    d, v = points[-1]
    return d, float(v)


def _mom24(points):
    """24 个月动量：最后一个点对比 730 天前最近一个点的涨幅（%），
    与页面 momentum() 口径一致（730 天回溯，取回溯日当天或之前最近一个点）。"""
    if not points or len(points) < 2:
        return None
    last_d, last_v = points[-1][0], float(points[-1][1])
    t = pd.Timestamp(last_d) - pd.Timedelta(days=730)
    base = None
    for d, v in points:
        if pd.Timestamp(d) <= t:
            base = float(v)
        else:
            break
    if base is None or base == 0:
        return None
    return (last_v / base - 1) * 100


def refresh_portfolio():
    """按最新序列刷新 portfolio.json 的读数/仪表/状态，机器人每次运行都跑。
    读数来源：PB 分位取 indicators.json 的 pb300，超额 CAPE（TIPS 版）取
    excape，黄金 24 个月动量由 markets.json 的 gold 序列算出。只有三项
    都刷新成功时才推进 readingsAsOf，避免新日期配旧读数。"""
    ppath = root / "src/data/portfolio.json"
    p = json.loads(ppath.read_text(encoding="utf-8"))
    ind = json.loads((root / "src/data/indicators.json").read_text(encoding="utf-8"))["series"]
    mk = json.loads((root / "src/data/markets.json").read_text(encoding="utf-8"))["series"]
    sig = {s["id"]: s for s in p["signals"]}
    done, notes = [], []
    pb = _series_last(ind.get("pb300", {}).get("points", []))
    if pb is not None:
        d, v = pb
        s = sig["cn-stock"]
        s["reading"] = f"{v:.0f}%"
        s["gauge"]["value"] = round(v, 1)
        s["state"], s["stateText"] = ("buy", "买入") if v < 30 else (("half", "半仓") if v <= 70 else ("wait", "等待"))
        done.append("pb300")
        notes.append(f"pb300 {v:.1f}% ({d})")
    ec = _series_last(ind.get("excape", {}).get("points", []))
    if ec is not None:
        d, v = ec
        s = sig["us-stock"]
        s["reading"] = f"{v:+.2f}%"
        s["gauge"]["value"] = max(-3, min(3, round(v, 1)))
        s["state"], s["stateText"] = ("buy", "购入") if v > 0 else ("wait", "等待")
        done.append("excape")
        notes.append(f"excape {v:+.2f}% ({d})")
    mom = _mom24(mk.get("gold", {}).get("points", []))
    if mom is not None:
        s = sig["gold"]
        s["reading"] = f"{mom:+.1f}%"
        s["state"], s["stateText"] = ("buy", "购入") if mom > 0 else ("wait", "等待")
        done.append("mom24")
        notes.append(f"gold mom24 {mom:+.1f}%")
    if len(done) == 3:
        p["report"]["readingsAsOf"] = pd.Timestamp.now().strftime("%Y-%m")
        ppath.write_text(json.dumps(p, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("ok   refresh_portfolio:", "; ".join(notes))
    else:
        missing = [k for k in ("pb300", "excape", "mom24") if k not in done]
        print(f"FAIL refresh_portfolio: missing {missing}, portfolio.json untouched", file=sys.stderr)


try:
    patch_markets()
except Exception as e:
    print(f"FAIL patch_markets: {e}", file=sys.stderr)

failed = 0
for key, fn in (("pb300", pb300), ("cn10y", cn10y), ("cbond", cbond), ("excape", excape)):
    try:
        pts = fn()
        store["series"][key] = {"points": pts}
        print(f"ok   {key} ({len(pts)} points, last {pts[-1]})")
    except Exception as e:
        failed += 1
        print(f"FAIL {key}: {e}", file=sys.stderr)

store["series"] = {k: v for k, v in store["series"].items() if k in ("pb300", "cn10y", "cbond", "excape")}
if store["series"]:
    store["updatedAt"] = pd.Timestamp.now(tz="UTC").isoformat()
out.write_text(json.dumps(store, ensure_ascii=False) + "\n", encoding="utf-8")

try:
    refresh_portfolio()
except Exception as e:
    print(f"FAIL refresh_portfolio: {e}", file=sys.stderr)

sys.exit(0)
