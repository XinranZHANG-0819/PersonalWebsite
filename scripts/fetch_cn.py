"""抓取 A 股与国内债的补充数据，写入 src/data/indicators.json（Yahoo 里没有这些）。

- pb300：沪深300 市净率的 10 年滚动分位（AkShare / 乐咕乐股）
- cn10y：中国国债 10 年期收益率（AkShare / 东方财富）
- cbond：中债新综合指数（财富指数，AkShare / 中央结算公司）
- excape：超额 CAPE 收益率估算（Shiller 公开数据）

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
    df = ak.bond_zh_us_rate(start_date="20150101")
    s = pd.Series(df["中国国债收益率10年"].astype(float).values, index=pd.to_datetime(df["日期"])).sort_index().dropna()
    if len(s) < 100:
        raise RuntimeError(f"too few points: {len(s)}")
    return to_points(s, 4)


def cbond():
    # 中债新综合指数（财富指数，含利息再投资，反映债券的总回报）
    df = ak.bond_new_composite_index_cbond(indicator="财富", period="总值")
    s = pd.Series(df.iloc[:, 1].astype(float).values, index=pd.to_datetime(df.iloc[:, 0])).sort_index().dropna()
    if len(s) < 100:
        raise RuntimeError(f"too few points: {len(s)}")
    return to_points(s, 4)


def excape_shiller():
    """超额 CAPE 收益率（估算）= 1/CAPE − （10 年美债收益率 − 过去 10 年平均通胀）。
    数据：Shiller 公开数据表（标普 500 的 CAPE、CPI、10 年国债利率），月度。"""
    import io, urllib.request
    url = "http://www.econ.yale.edu/~shiller/data/ie_data.xls"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    raw = urllib.request.urlopen(req, timeout=60).read()
    df = pd.read_excel(io.BytesIO(raw), sheet_name="Data", skiprows=7)
    print("  shiller columns:", list(df.columns)[:14], "rows:", len(df))
    date_col = df.columns[0]
    cape_col = next(c for c in df.columns if str(c).strip().upper().startswith("CAPE"))
    cpi_col = next(c for c in df.columns if str(c).strip().upper() == "CPI")
    rate_col = next(c for c in df.columns if "Rate" in str(c) and "GS10" in str(c)) if any("GS10" in str(c) for c in df.columns) else df.columns[6]
    d = df[[date_col, cape_col, cpi_col, rate_col]].copy()
    d.columns = ["date", "cape", "cpi", "rate"]
    d = d[pd.to_numeric(d["date"], errors="coerce").notna()]
    d["date"] = d["date"].astype(float)
    # 日期格式 YYYY.MM（10 月写作 YYYY.1）
    yr = d["date"].astype(int)
    mo = ((d["date"] - yr) * 100).round().astype(int).clip(1, 12)
    d.index = pd.to_datetime(dict(year=yr, month=mo, day=1)) + pd.offsets.MonthEnd(0)
    for c in ("cape", "cpi", "rate"):
        d[c] = pd.to_numeric(d[c], errors="coerce")
    d = d.dropna(subset=["cape", "cpi", "rate"])
    infl = ((d["cpi"] / d["cpi"].shift(120)) ** (1 / 10) - 1) * 100
    ex = (100 / d["cape"]) - (d["rate"] - infl)
    ex = ex.dropna()
    if len(ex) < 60:
        raise RuntimeError(f"too few points: {len(ex)}")
    return to_points(ex, 2)


def _http(url: str) -> bytes:
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (personal-website data fetcher)"})
    return urllib.request.urlopen(req, timeout=60).read()


def _month_end(idx) -> pd.DatetimeIndex:
    return pd.DatetimeIndex(pd.to_datetime(idx)) + pd.offsets.MonthEnd(0)


def _bls_cpi() -> pd.Series:
    """CPI-U（BLS，系列 CUUR0000SA0，月度，未季调）。

    2026-10 之前 excape 用的是 FRED 的 CPIAUCSL，但 FRED 的 fredgraph.csv
    现对自动抓取返回 403，excape_current 因此一直失败、回落到 2023-09 就
    停更的 Shiller 旧表——这就是曲线“消失”的根因。BLS 公开 API 无需 key
    即可取，单次查询最多约 10 年，所以按 10 年窗口分段取再合并。
    用未季调 CPI 算 10 年平均通胀是合理的：分子分母是同一月份、相隔
    10 年，季节因素基本抵消。
    """
    import json as _json
    parts = []
    now_y = pd.Timestamp.now().year
    for a, b in [(2006, 2015), (2016, 2025), (2026, now_y)]:
        if a > now_y:
            continue
        raw = _http(f"https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0?startyear={a}&endyear={b}")
        data = _json.loads(raw)
        if data.get("status") != "REQUEST_SUCCEEDED":
            raise RuntimeError(f"BLS {a}-{b}: {data.get('status')} {data.get('message')}")
        rows = data["Results"]["series"][0]["data"]
        vals, dates = [], []
        for r in rows:
            if not r["period"].startswith("M"):
                continue
            vals.append(float(r["value"]) if r["value"] != "-" else float("nan"))
            dates.append(f"{r['year']}-{r['period'][1:]}-01")
        parts.append(pd.Series(vals, index=_month_end(dates)))
    ser = pd.concat(parts).sort_index()
    ser = ser[~ser.index.duplicated(keep="last")].dropna()
    if len(ser) < 60:
        raise RuntimeError(f"BLS CPI too few points: {len(ser)}")
    return ser


def _gs10_month_end() -> pd.Series:
    """10 年美债收益率的月末值。首选本仓库已有的 markets.json（雅虎 ^TNX，
    工作流里 fetch-data.mjs 先跑、比本脚本新），缺失或过旧时才直接问雅虎。"""
    mpath = root / "src/data/markets.json"
    try:
        m = json.loads(mpath.read_text(encoding="utf-8"))
        pts = m["series"]["us10y"]["points"]
        me = {}
        for d, v in pts:
            me[d[:7]] = float(v)
        idx = _month_end([f"{k}-01" for k in me])
        ser = pd.Series(list(me.values()), index=idx).sort_index()
        if len(ser) >= 60 and ser.index[-1] >= pd.Timestamp.now() - pd.Timedelta(days=120):
            return ser
    except Exception as e:
        print(f"  gs10 from markets.json unavailable: {e}", file=sys.stderr)
    import json as _json
    raw = _http("https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?range=10y&interval=1d")
    r = _json.loads(raw)["chart"]["result"][0]
    dates = [pd.Timestamp(ts, unit="s").strftime("%Y-%m-%d") for ts in r["timestamp"]]
    closes = r["indicators"]["quote"][0]["close"]
    me = {}
    for d, v in zip(dates, closes):
        if v is not None:
            me[d[:7]] = float(v)
    idx = _month_end([f"{k}-01" for k in me])
    return pd.Series(list(me.values()), index=idx).sort_index()


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


def excape_current():
    """超额 CAPE 收益率（估算）= 1/CAPE − （10 年美债收益率 − 过去 10 年平均通胀）。
    公式不变，数据源换了：CAPE 用 multpl（标普 500 席勒市盈率，月度，实时
    更新）；10 年美债收益率用雅虎 ^TNX 月末值（即 markets.json 的 us10y）；
    CPI 用 BLS 的 CPI-U。原 FRED 路径已失效，见 _bls_cpi 的注释。"""
    cape = _multpl_cape()
    gs10 = _gs10_month_end()
    cpi = _bls_cpi()
    print("  cape", cape.index[-1].date(), cape.iloc[-1], "| gs10", gs10.index[-1].date(), gs10.iloc[-1], "| cpi", cpi.index[-1].date(), cpi.iloc[-1])
    df = pd.concat([cape.rename("cape"), gs10.rename("gs10"), cpi.rename("cpi")], axis=1).sort_index()
    df[["gs10", "cpi"]] = df[["gs10", "cpi"]].ffill(limit=2)   # 利率、CPI 公布略晚，向前补最多 2 个月
    infl = ((df["cpi"] / df["cpi"].shift(120)) ** (1 / 10) - 1) * 100
    ex = ((100 / df["cape"]) - (df["gs10"] - infl)).dropna()
    if len(ex) < 60:
        raise RuntimeError(f"too few points: {len(ex)}")
    if ex.index[-1] < pd.Timestamp.now() - pd.Timedelta(days=120):
        raise RuntimeError(f"stale: last {ex.index[-1].date()}")
    today = pd.Timestamp.now().normalize()
    ex.index = pd.DatetimeIndex([min(d, today) for d in ex.index])   # 当月的点按月底标注会晚于今天，压到今天
    return to_points(ex, 2)


def excape():
    # 注意：不要再把 excape_shiller 当兜底。耶鲁 Shiller 表最后一次更新是
    # 2023-09，兜底会把序列悄悄倒回 2023 年，页面默认 1 年视图里这条线
    # 因超出窗口被裁掉、看起来就是“没有了”，而其他序列照常更新、毫无报错。
    # 新路径失败时宁可保留上一次的近期数据（脚本主循环的失败保留逻辑），
    # 并在日志里留下 FAIL excape，便于发现。
    return excape_current()


def patch_markets():
    """沪深300、创业板指、上证指数：Yahoo 偶尔只返回很少的点，用新浪的日线覆盖，保证 A 股指数是完整的。"""
    mpath = root / "src/data/markets.json"
    m = json.loads(mpath.read_text(encoding="utf-8"))
    changed = 0
    for sid, sym in (("sh000300", "sh000300"), ("sz399006", "sz399006"), ("sh000001", "sh000001")):
        try:
            df = ak.stock_zh_index_daily(symbol=sym)
            ser = pd.Series(df["close"].astype(float).values, index=pd.to_datetime(df["date"])).sort_index().dropna()
            pts = to_points(ser, 4)
            if len(pts) < 200:
                raise RuntimeError(f"too few points: {len(pts)}")
            m["series"][sid] = {"points": pts}
            changed += 1
            print(f"ok   {sid} via sina ({len(pts)} points, last {pts[-1]})")
        except Exception as e:
            print(f"FAIL {sid} via sina: {e}", file=sys.stderr)
    if changed:
        mpath.write_text(json.dumps(m, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


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
sys.exit(0)
