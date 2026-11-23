#!/usr/bin/env python3
"""
美股融資熱度指數（每日推估）——對照台股、美股的抄底點

    python3 scripts/heat_index.py <資料資料夾> [--png 輸出圖檔]

為什麼：美股官方的融資餘額一個月、甚至一季才公布一次，太慢。用「每天都會更新」的公開資料，
推估一條每天更新的散戶融資熱度線（0～100）：0＝散戶多頭死絕、籌碼最乾淨；100＝散戶最瘋狂。
跌破 30 是「籌碼極度乾淨」的抄底區，超過 80 是過熱區。

五個元件（照原始構想，每個先換成「過去 252 天的百分位數」，越熱分數越高）：
  1. 個股選擇權 Put/Call 比（CBOE Equity P/C）  反向：散戶狂買 Put＝恐慌＝低分   us/PCR.json
  2. 全市場選擇權 Put/Call 比（CBOE Total P/C）  反向                               us/PCR.json
  3. 融資年增率（FRED Z.1 券商對客戶的融資應收，季資料，當作中長線槓桿的定錨）     FRED BOGZ1FL663067003Q
  4. 淨流動性（聯準會總資產 − TGA − 逆回購，13 週變化；參考 M2 年增率）            FRED WALCL、WTREGEN、RRPONTSYD、M2SL
  5. 散戶 FOMO／恐慌（S&P 500 離 50 日均線的乖離、20 日動能、成交量能）             us/GSPC.json＋Yahoo 成交量
  抓不到的元件就不用（剩下的平均），不會讓程式失敗；網頁會列出哪些有用到。

不偷看：每個元件只用「當天已經公布」的資料——
  FRED 週資料從觀測日 + 2 天起、M2 從月初 + 60 天起、Z.1 季資料從季初 + 165 天起（季末後約 75 天公布）才算知道。
權重：五個元件等權平均（不拿歷史去調權重，避免「調到剛好符合過去」）。
台股：美國 D 日的熱度，對到 D 日之後的第一個台股交易日（美股週五 → 台股週一）。

驗證（事件研究）：熱度「跌破 30」那天之後 20、60 個交易日 S&P 500 與加權指數的報酬，跟「隨便哪一天」比。

輸出：<資料資料夾>/heat-index.json（網站預測頁）、圖檔（--png，預設 <資料資料夾>/heat-index.png）。
"""
from __future__ import annotations

import io
import json
import sys
import urllib.request
from datetime import timedelta
from pathlib import Path

import numpy as np
import pandas as pd

BUY = 30.0
HOT = 80.0
WINDOW = 252
UA = {"User-Agent": "Mozilla/5.0 (heat-index research script)"}


def log(*a: object) -> None:
    print(*a, flush=True)


def http_get(url: str, timeout: int = 60) -> bytes | None:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
            return r.read()
    except Exception as e:
        log(f"  抓不到 {url.split('?')[0]}：{e}")
        return None


def read_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def fred(series_id: str) -> pd.Series | None:
    raw = http_get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}")
    if not raw:
        return None
    try:
        df = pd.read_csv(io.BytesIO(raw))
        df.columns = ["date", "v"]
        df["v"] = pd.to_numeric(df["v"], errors="coerce")
        s = pd.Series(df["v"].values, index=pd.to_datetime(df["date"])).dropna()
        log(f"  FRED {series_id}：{len(s)} 筆（{s.index[0].date()}～{s.index[-1].date()}）")
        return s
    except Exception as e:
        log(f"  FRED {series_id} 格式不符：{e}")
        return None


def yahoo_volume(symbol: str) -> pd.Series | None:
    raw = http_get(f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.request.quote(symbol)}?range=10y&interval=1d")
    if not raw:
        return None
    try:
        j = json.loads(raw)["chart"]["result"][0]
        ts = pd.to_datetime(j["timestamp"], unit="s").normalize()
        return pd.Series(j["indicators"]["quote"][0]["volume"], index=ts, dtype=float).replace(0, np.nan).dropna()
    except Exception as e:
        log(f"  Yahoo {symbol} 成交量格式不符：{e}")
        return None


def ohlc(d: Path, rel: str) -> pd.Series | None:
    rows = read_json(d / rel)
    if not rows:
        return None
    return pd.Series([r[4] for r in rows], index=pd.to_datetime([r[0] for r in rows]), dtype=float).sort_index()


def known_on(s: pd.Series, dates: pd.DatetimeIndex, lag_days: int) -> pd.Series:
    """觀測日 + lag_days 才算知道：每個日子用「已經知道」的最新一筆。"""
    a = s.copy()
    a.index = a.index + timedelta(days=lag_days)
    m = pd.merge_asof(pd.DataFrame({"d": dates}), pd.DataFrame({"t": a.index, "v": a.values}).sort_values("t"), left_on="d", right_on="t", direction="backward")
    return pd.Series(m["v"].values, index=dates)


def pct_rank(s: pd.Series, invert: bool = False, window: int = WINDOW) -> pd.Series:
    """當天的值在過去 window 天（含當天）的百分位數 0～100，只用當天以前的資料。"""
    v = s.values.astype(float)
    out = np.full(len(v), np.nan)
    for i in range(len(v)):
        if not np.isfinite(v[i]):
            continue
        w = v[max(0, i - window + 1) : i + 1]
        w = w[np.isfinite(w)]
        if len(w) < window // 2:
            continue
        out[i] = 100.0 * ((w < v[i]).sum() + 0.5 * ((w == v[i]).sum() - 1)) / max(1, len(w) - 1)
    out = np.clip(out, 0, 100)
    return pd.Series(100 - out if invert else out, index=s.index)


COMPONENTS = {
    "equityPC": "個股選擇權 Put/Call 比（反向）",
    "totalPC": "全市場選擇權 Put/Call 比（反向）",
    "marginYoY": "融資年增率（FRED 季資料，定錨）",
    "liquidity": "淨流動性（聯準會資產 − TGA − 逆回購，參考 M2）",
    "fomo": "散戶 FOMO／恐慌（乖離、動能、量能）",
}


def build(d: Path) -> tuple[pd.Series, pd.DataFrame, dict[str, str]]:
    spx = ohlc(d, "us/GSPC.json")
    if spx is None:
        sys.exit("沒有 S&P 500 資料（us/GSPC.json）")
    days = spx.index
    comp: dict[str, pd.Series] = {}
    src: dict[str, str] = {}

    # 1、2 選擇權 Put/Call 比
    pcr = read_json(d / "us" / "PCR.json") or {}
    rows = [(k, v) for k, v in pcr.items() if v]
    if len(rows) > WINDOW:
        df = pd.DataFrame([[k, *v] for k, v in rows], columns=["d", "total", "equity", "index"]).set_index("d")
        df.index = pd.to_datetime(df.index)
        df = df.apply(pd.to_numeric, errors="coerce").reindex(days)
        # 單日雜訊大：用 5 日平均
        if df["equity"].notna().sum() > WINDOW:
            comp["equityPC"] = pct_rank(df["equity"].rolling(5, min_periods=3).mean(), invert=True)
            src["equityPC"] = "CBOE（us/PCR.json）"
        if df["total"].notna().sum() > WINDOW:
            comp["totalPC"] = pct_rank(df["total"].rolling(5, min_periods=3).mean(), invert=True)
            src["totalPC"] = "CBOE（us/PCR.json）"
    else:
        log(f"  Put/Call 比資料還不夠（{len(rows)} 天，至少要 {WINDOW} 天；每次資料更新往回補 250 天）")

    # 3 融資年增率（季）
    mg = fred("BOGZ1FL663067003Q")
    if mg is not None and len(mg) > 8:
        yoy = mg.pct_change(4)
        comp["marginYoY"] = pct_rank(known_on(yoy, days, 165), window=WINDOW * 3)
        src["marginYoY"] = "FRED BOGZ1FL663067003Q"

    # 4 淨流動性
    walcl, tga, rrp, m2 = fred("WALCL"), fred("WTREGEN"), fred("RRPONTSYD"), fred("M2SL")
    if walcl is not None and tga is not None:
        net = walcl - tga.reindex(walcl.index, method="ffill")
        if rrp is not None:
            net = net - rrp.reindex(walcl.index, method="ffill").fillna(0) * 1000  # RRP 單位是十億，其他是百萬
        chg = known_on(net.dropna().pct_change(13), days, 2)
        parts = [pct_rank(chg)]
        if m2 is not None:
            parts.append(pct_rank(known_on(m2.pct_change(12), days, 60)))
        comp["liquidity"] = pd.concat(parts, axis=1).mean(axis=1, skipna=True)
        src["liquidity"] = "FRED WALCL、WTREGEN" + ("、RRPONTSYD" if rrp is not None else "") + ("、M2SL" if m2 is not None else "")

    # 5 FOMO／恐慌
    dev = spx / spx.rolling(50).mean() - 1
    mom = spx.pct_change(20)
    parts = [pct_rank(dev), pct_rank(mom)]
    vol = yahoo_volume("^GSPC")
    if vol is not None:
        vr = (vol.rolling(20).mean() / vol.rolling(120).mean()).reindex(days)
        # 上漲時量大＝FOMO、下跌時量大＝恐慌：量能乘上 20 日漲跌的方向
        parts.append(pct_rank(np.sign(mom) * vr))
    comp["fomo"] = pd.concat(parts, axis=1).mean(axis=1, skipna=True)
    src["fomo"] = "us/GSPC.json" + ("＋Yahoo 成交量" if vol is not None else "")

    scores = pd.DataFrame(comp, index=days)
    for k in COMPONENTS:
        if k not in scores:
            log(f"  不用：{COMPONENTS[k]}（沒有資料）")
    return spx, scores, src


def event_study(score: pd.Series, close: pd.Series, hs=(20, 60)) -> dict:
    """熱度跌破 BUY（前一天還在上面）那天之後 h 天的報酬，跟所有日子比；事件之間至少隔 20 天。"""
    s = score.reindex(close.index)
    ev = []
    last = -999
    for i in range(1, len(s)):
        if np.isfinite(s.iloc[i]) and s.iloc[i] < BUY and np.isfinite(s.iloc[i - 1]) and s.iloc[i - 1] >= BUY and i - last > 20:
            ev.append(i)
            last = i
    out = {"events": [str(close.index[i].date()) for i in ev]}
    for h in hs:
        fwd = close.shift(-h) / close - 1
        e = fwd.iloc[ev].dropna()
        a = fwd[s.notna()].dropna()
        out[str(h)] = {"n": int(len(e)), "avg": float(e.mean()) if len(e) else None, "up": float((e > 0).mean()) if len(e) else None, "allAvg": float(a.mean()), "allUp": float((a > 0).mean())}
    return out


def plot(spx: pd.Series, twii: pd.Series | None, score: pd.Series, path: Path, title: str) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import font_manager

    for f in ["Noto Sans CJK TC", "Noto Sans TC", "WenQuanYi Zen Hei", "Microsoft JhengHei", "PingFang TC"]:
        if any(f in x.name for x in font_manager.fontManager.ttflist):
            plt.rcParams["font.sans-serif"] = [f]
            break
    plt.rcParams["axes.unicode_minus"] = False
    panels = [("S&P 500", spx)] + ([("台灣加權指數", twii)] if twii is not None else [])
    fig, axes = plt.subplots(len(panels) + 1, 1, figsize=(14, 3.6 * (len(panels) + 1)), sharex=True)
    for ax, (name, c) in zip(axes, panels):
        df = pd.DataFrame({"c": c, "s": score.reindex(c.index)}).dropna()
        ax.plot(df.index, df.c, color="#333", lw=1.1, label=name)
        lo, hi = df[df.s < BUY], df[df.s > HOT]
        ax.scatter(lo.index, lo.c * 0.975, marker="^", color="#16a34a", s=22, label=f"熱度 < {BUY:.0f}（籌碼乾淨，抄底區）", zorder=3)
        ax.scatter(hi.index, hi.c * 1.025, marker="v", color="#dc2626", s=22, label=f"熱度 > {HOT:.0f}（散戶瘋狂）", zorder=3)
        ax.legend(loc="upper left")
        ax.grid(alpha=0.25)
    axes[0].set_title(title)
    a = axes[-1]
    a.plot(score.index, score, color="#2563eb", lw=1.1, label="美股融資熱度")
    a.axhline(BUY, color="gray", ls="--", lw=1)
    a.axhline(HOT, color="gray", ls="--", lw=1)
    a.axhspan(0, BUY, color="#bbf7d0", alpha=0.5, label="籌碼乾淨（抄底區）")
    a.axhspan(HOT, 100, color="#fecaca", alpha=0.5, label="過熱區")
    a.set_ylim(0, 100)
    a.legend(loc="upper left")
    a.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    d = Path(args[0] if args else "data")
    png = Path(sys.argv[sys.argv.index("--png") + 1]) if "--png" in sys.argv else d / "heat-index.png"
    log("美股融資熱度指數：讀資料⋯")
    spx, scores, src = build(d)
    used = list(scores.columns)
    score = scores.mean(axis=1, skipna=True).where(scores.notna().sum(axis=1) >= max(1, (len(used) + 1) // 2))
    score = score.dropna()
    log(f"  用到 {len(used)} 個元件：{'、'.join(COMPONENTS[k] for k in used)}")

    # 台股：美國 D 日 → D 日之後的第一個台股交易日
    twii = ohlc(d, "index/TAIEX.json")
    tw_score = None
    if twii is not None:
        m = pd.merge_asof(pd.DataFrame({"tw": twii.index}), pd.DataFrame({"us": score.index, "s": score.values}), left_on="tw", right_on="us", direction="backward", allow_exact_matches=False)
        tw_score = pd.Series(m["s"].values, index=twii.index)

    ev_us = event_study(score, spx)
    ev_tw = event_study(tw_score, twii) if tw_score is not None else None

    now, prev = float(score.iloc[-1]), float(score.iloc[-2])
    if now < BUY:
        advice = "籌碼極度乾淨（抄底區）" + ("：熱度開始回升" if now > prev else "：還在往下")
    elif now > HOT:
        advice = "散戶過熱：小心回檔"
    else:
        advice = "中性"
    pct = lambda x: "—" if x is None else f"{x * 100:+.1f}%"
    log("\n================ 結果 ================")
    log(f"最新熱度：{now:.1f}（前一天 {prev:.1f}），美國 {score.index[-1].date()}　→ {advice}")
    for k in used:
        v = scores[k].dropna()
        log(f"  {COMPONENTS[k]:<30} 權重 {100 / len(used):5.1f}%   今天 {v.iloc[-1]:5.1f}   （{src.get(k, '')}）")
    for name, ev in [("S&P 500", ev_us), ("加權指數", ev_tw)]:
        if not ev:
            continue
        log(f"\n跌破 {BUY:.0f} 之後（{name}，共 {len(ev['events'])} 次：{'、'.join(ev['events'][-6:])}{'⋯' if len(ev['events']) > 6 else ''}）")
        for h in ("20", "60"):
            x = ev[h]
            upt = "—" if x["up"] is None else f"{x['up'] * 100:.0f}%"
            log(f"  {h} 日後  平均 {pct(x['avg'])}  上漲機率 {upt}　｜ 隨便哪一天 {pct(x['allAvg'])}、{x['allUp'] * 100:.0f}%")

    plot(spx, twii, score, png, f"美股融資熱度（每日推估）　最新 {now:.0f}（美國 {score.index[-1].date()}）")
    log(f"\n圖：{png}")

    start = score.index[-1] - pd.Timedelta(days=365 * 3)
    us_dates = score.index[score.index >= start]
    tw_map = {}
    if twii is not None:
        nxt = pd.merge_asof(pd.DataFrame({"us": us_dates}), pd.DataFrame({"tw": twii.index, "c": twii.values}), left_on="us", right_on="tw", direction="forward", allow_exact_matches=False)
        tw_map = {u: (None if pd.isna(c) else round(float(c), 2)) for u, c in zip(us_dates, nxt["c"])}
    out = {
        "generatedAt": pd.Timestamp.now(tz="UTC").isoformat(),
        "kind": "us-margin",
        "asOf": str(score.index[-1].date()),
        "thresholds": {"buy": BUY, "hot": HOT},
        "now": round(now, 1),
        "prev": round(prev, 1),
        "advice": advice,
        "components": [{"id": k, "name": COMPONENTS[k], "source": src.get(k, ""), "weight": round(1 / len(used), 4), "score": round(float(scores[k].dropna().iloc[-1]), 1)} for k in used],
        "missing": [COMPONENTS[k] for k in COMPONENTS if k not in used],
        "events": {"us": ev_us, "tw": ev_tw},
        # [美國日期, S&P 500, 之後第一個台股交易日的加權指數, 熱度]
        "series": [[str(u.date()), round(float(spx.loc[u]), 2), tw_map.get(u), round(float(score.loc[u]), 1)] for u in us_dates],
    }
    (d / "heat-index.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    log(f"輸出：{d / 'heat-index.json'}")


if __name__ == "__main__":
    main()
