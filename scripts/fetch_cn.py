"""抓取 A 股与国内债的补充数据，写入 src/data/indicators.json（Yahoo 里没有这些）。

- pb300：沪深300 市净率的 10 年滚动分位（AkShare / 乐咕乐股）
- bond161119：易方达中债新综指 161119 的累计净值（AkShare / 东方财富）

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


def pb300():
    WINDOW = 2430  # ≈ 10 年交易日
    df = ak.stock_index_pb_lg(symbol="沪深300")
    date_col = "日期" if "日期" in df.columns else df.columns[0]
    pb_col = next(c for c in df.columns if "市净率" in c and not any(k in c for k in ("等权", "中位", "分位")))
    s = pd.Series(df[pb_col].astype(float).values, index=pd.to_datetime(df[date_col])).sort_index().dropna()
    if len(s) < WINDOW + 60:
        raise RuntimeError(f"history too short: {len(s)}")
    pct = s.rolling(WINDOW, min_periods=WINDOW).apply(lambda w: (w <= w[-1]).mean() * 100, raw=True).dropna()
    return to_points(pct, 1)


def bond161119():
    df = ak.fund_open_fund_info_em(symbol="161119", indicator="累计净值走势")
    s = pd.Series(df.iloc[:, 1].astype(float).values, index=pd.to_datetime(df.iloc[:, 0])).sort_index().dropna()
    if len(s) < 100:
        raise RuntimeError(f"too few points: {len(s)}")
    return to_points(s, 4)


failed = 0
for key, fn in (("pb300", pb300), ("bond161119", bond161119)):
    try:
        pts = fn()
        store["series"][key] = {"points": pts}
        print(f"ok   {key} ({len(pts)} points, last {pts[-1]})")
    except Exception as e:
        failed += 1
        print(f"FAIL {key}: {e}", file=sys.stderr)

if store["series"]:
    store["updatedAt"] = pd.Timestamp.now(tz="UTC").isoformat()
out.write_text(json.dumps(store, ensure_ascii=False) + "\n", encoding="utf-8")
sys.exit(0)
