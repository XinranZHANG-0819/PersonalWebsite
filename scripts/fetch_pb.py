"""抓取沪深300 市净率，计算 10 年滚动分位，写入 src/data/indicators.json。
数据来自 AkShare（乐咕乐股）。失败时保留旧文件，不影响行情数据。
分位 = 过去 10 年（约 2430 个交易日）里，市净率不高于当日值的天数占比。
"""
import json, sys, pathlib
import pandas as pd

root = pathlib.Path(__file__).resolve().parent.parent
out = root / "src/data/indicators.json"
WINDOW = 2430   # ≈ 10 年交易日
KEEP_DAYS = 3 * 366

try:
    import akshare as ak
    df = ak.stock_index_pb_lg(symbol="沪深300")
    date_col = "日期" if "日期" in df.columns else df.columns[0]
    pb_col = next(c for c in df.columns if "市净率" in c and "等权" not in c and "中位" not in c and "分位" not in c)
    s = pd.Series(df[pb_col].astype(float).values, index=pd.to_datetime(df[date_col])).sort_index().dropna()
    if len(s) < WINDOW + 60:
        raise RuntimeError(f"history too short: {len(s)}")
    pct = s.rolling(WINDOW, min_periods=WINDOW).apply(lambda w: (w <= w[-1]).mean() * 100, raw=True).dropna()
    pct = pct[pct.index >= pct.index[-1] - pd.Timedelta(days=KEEP_DAYS)]
    points = [[d.strftime("%Y-%m-%d"), round(float(v), 1)] for d, v in pct.items()]
    payload = {"updatedAt": pd.Timestamp.utcnow().isoformat(), "series": {"pb300": {"points": points}}}
    out.write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"ok pb300 ({len(points)} points, last {points[-1]})")
except Exception as e:
    print(f"FAIL pb300: {e}", file=sys.stderr)
    if not out.exists():
        out.write_text(json.dumps({"updatedAt": None, "series": {}}) + "\n", encoding="utf-8")
    sys.exit(0)
