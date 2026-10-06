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


def _fred(series_id: str) -> pd.Series:
    import io
    df = pd.read_csv(io.BytesIO(_http(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}")))
    df.columns = ["date", "v"]
    return pd.Series(pd.to_numeric(df["v"], errors="coerce").values, index=_month_end(df["date"])).dropna()


def _multpl_cape() -> pd.Series:
    import io
    html = _http("https://www.multpl.com/shiller-pe/table/by-month").decode("utf-8", "ignore")
    t = pd.read_html(io.StringIO(html))[0]
    t.columns = ["date", "v"]
    d = pd.to_datetime(t["date"], errors="coerce")
    v = pd.to_numeric(t["v"].astype(str).str.extract(r"([\d.]+)")[0], errors="coerce")
    ser = pd.Series(v.values, index=_month_end(d.fillna(pd.Timestamp("1900-01-31")))).dropna()
    return ser[ser.index > "1950-01-01"].sort_index()


def excape_current():
    """超额 CAPE 收益率（估算）= 1/CAPE − （10 年美债收益率 − 过去 10 年平均通胀）。
    CAPE：multpl（标普 500 席勒市盈率，月度，实时更新）；10 年美债利率 GS10、CPI：美联储 FRED。"""
    cape = _multpl_cape()
    gs10 = _fred("GS10")
    cpi = _fred("CPIAUCSL")
    print("  cape", cape.index[-1].date(), cape.iloc[-1], "| gs10", gs10.index[-1].date(), gs10.iloc[-1], "| cpi", cpi.index[-1].date())
    df = pd.concat([cape.rename("cape"), gs10.rename("gs10"), cpi.rename("cpi")], axis=1).sort_index()
    df[["gs10", "cpi"]] = df[["gs10", "cpi"]].ffill(limit=2)   # 利率、CPI 公布略晚，向前补最多 2 个月
    infl = ((df["cpi"] / df["cpi"].shift(120)) ** (1 / 10) - 1) * 100
    ex = ((100 / df["cape"]) - (df["gs10"] - infl)).dropna()
    if len(ex) < 60:
        raise RuntimeError(f"too few points: {len(ex)}")
    if ex.index[-1] < pd.Timestamp.now() - pd.Timedelta(days=120):
        raise RuntimeError(f"stale: last {ex.index[-1].date()}")
    return to_points(ex, 2)


def excape():
    errs = []
    for fn in (excape_current, excape_shiller):
        try:
            return fn()
        except Exception as e:
            errs.append(f"{fn.__name__}: {e}")
            print("  ", errs[-1], file=sys.stderr)
    raise RuntimeError("; ".join(errs))


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
