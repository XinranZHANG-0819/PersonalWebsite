"""抓取 A 股与国内债的补充数据，写入 src/data/indicators.json（Yahoo 里没有这些）。

- pb300：沪深300 市净率的 10 年滚动分位（AkShare / 乐咕乐股）
- cn10y：中国国债 10 年期收益率（AkShare / 东方财富）
- cbond：中债新综合指数（财富指数，AkShare / 中央结算公司）

每个序列单独抓取，失败时保留它上一次的数据，不影响其他序列。
"""
import json, sys, pathlib
import pandas as pd

root = pathlib.Path(__file__).resolve().parent.parent
out = root / "src/data/indicators.json"
KEEP = pd.Timedelta(days=3 * 366 + 10)

try:
    store = json.loads(out.read_text(encoding="utf-8"))
    store.setdefault("series", {})
except Exception:
    store = {"updatedAt": None, "series": {}}

import akshare as ak


def to_points(s: pd.Series, nd: int):
    s = s[s.index >= s.index[-1] - KEEP]
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
    df = ak.bond_zh_us_rate(start_date="20220101")
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
for key, fn in (("pb300", pb300), ("cn10y", cn10y), ("cbond", cbond)):
    try:
        pts = fn()
        store["series"][key] = {"points": pts}
        print(f"ok   {key} ({len(pts)} points, last {pts[-1]})")
    except Exception as e:
        failed += 1
        print(f"FAIL {key}: {e}", file=sys.stderr)

store["series"] = {k: v for k, v in store["series"].items() if k in ("pb300", "cn10y", "cbond")}
if store["series"]:
    store["updatedAt"] = pd.Timestamp.now(tz="UTC").isoformat()
out.write_text(json.dumps(store, ensure_ascii=False) + "\n", encoding="utf-8")
sys.exit(0)
