#!/usr/bin/env python3
"""
台美融資熱度指數（每日推估）——美股原始五元件＋台股籌碼，看台股的抄底點

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

台股組（五個）：融資維持率、融資餘額 20 日變化、外資台指期淨未平倉、散戶小台淨多單比（FinMind）、台股 FOMO（加權指數乖離、動能）。
權重：十個元件的權重用最佳化挑——目標是「熱度越低、之後 60 個交易日加權指數漲越多」（等級相關係數），\n  再往等權拉回一半（降低過度配適）；成績用逐年往前滾（每年只用之前、答案已揭曉的資料挑權重）。台股日期為準，美國 D 日的分數對到 D 日之後的第一個台股交易日。

驗證（事件研究）：熱度「跌破 30」那天之後 20、60 個交易日加權指數的報酬，跟「隨便哪一天」比。

輸出：<資料資料夾>/heat-index.json（網站預測頁）、圖檔（--png，預設 <資料資料夾>/heat-index.png）。
"""
from __future__ import annotations

import io
import json
import os
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


def _fred_csv(series_id: str) -> pd.Series | None:
    for host in ("fred.stlouisfed.org", "alfred.stlouisfed.org"):
        raw = http_get(f"https://{host}/graph/fredgraph.csv?id={series_id}", timeout=30)
        if not raw:
            continue
        try:
            df = pd.read_csv(io.BytesIO(raw))
            df.columns = ["date", "v"]
            df["v"] = pd.to_numeric(df["v"], errors="coerce")
            return pd.Series(df["v"].values, index=pd.to_datetime(df["date"])).dropna()
        except Exception as e:
            log(f"  FRED {series_id}（{host}）格式不符：{e}")
    return None


def _fred_api(series_id: str) -> pd.Series | None:
    """FRED 官方 API（另一個主機；要免費金鑰，放 GitHub Secret FRED_API_KEY）。"""
    key = os.environ.get("FRED_API_KEY")
    if not key:
        return None
    raw = http_get(f"https://api.stlouisfed.org/fred/series/observations?series_id={series_id}&api_key={key}&file_type=json", timeout=60)
    if not raw:
        return None
    try:
        obs = json.loads(raw)["observations"]
        return pd.Series(pd.to_numeric([o["value"] for o in obs], errors="coerce"), index=pd.to_datetime([o["date"] for o in obs])).dropna()
    except Exception as e:
        log(f"  FRED API {series_id} 格式不符：{e}")
        return None


_FRED_DOWN = False


def fred(series_id: str) -> pd.Series | None:
    """FRED：先試網頁 CSV（兩個主機），抓不到再試官方 API；CSV 連續逾時就不再試 CSV（省時間）。"""
    global _FRED_DOWN
    s = None if _FRED_DOWN else _fred_csv(series_id)
    via = "CSV"
    if s is None:
        _FRED_DOWN = True
        s, via = _fred_api(series_id), "API"
    if s is None or not len(s):
        log(f"  FRED {series_id}：抓不到" + ("" if os.environ.get("FRED_API_KEY") else "（GitHub 上連 FRED 網頁會逾時；設 Secret FRED_API_KEY 可改走官方 API）"))
        return None
    log(f"  FRED {series_id}（{via}）：{len(s)} 筆（{s.index[0].date()}～{s.index[-1].date()}）")
    return s


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


def rule_study(score: pd.Series, close: pd.Series, ratio: pd.Series | None) -> list[dict]:
    """「熱度低」只代表籌碼乾淨，不代表跌完。比較幾種「確認到底」的進場規則（事先定好，不從結果挑參數）：
    事件之間至少隔 20 天，看之後 20／60 日加權指數，跟隨便哪一天比；並拆開發期（～2025-10）與保留期。"""
    s = score.reindex(close.index)
    mn20 = s.rolling(20, min_periods=5).min()
    mn60 = s.shift(1).rolling(60, min_periods=20).min()
    low60 = close <= close.rolling(60).min()
    r = ratio.reindex(close.index).ffill(limit=3) if ratio is not None else pd.Series(np.nan, index=close.index)
    rules = {
        "跌破 30（原本）": (s < BUY) & (s.shift(1) >= BUY),
        "跌破 30 後回升站上 30": (s >= BUY) & (s.shift(1) < BUY),
        "低檔（20 日內 < 20）反彈 10 分以上": (mn20 < 20) & (s - mn20 >= 10) & (s < 50),
        "指數創 60 日新低、熱度沒創新低（背離）": low60 & (s > mn60 + 10) & (s < 40),
        "熱度 < 30 ＋ 融資維持率 < 140%": (s < BUY) & (r < 140),
    }
    out = []
    f20, f60 = close.shift(-20) / close - 1, close.shift(-60) / close - 1
    valid = s.notna()
    for name, sig in rules.items():
        sig = sig.fillna(False) & valid
        ev, last = [], -999
        for i in np.flatnonzero(sig.values):
            if i - last > 20:
                ev.append(i)
                last = i
        idx = close.index[ev]
        e20, e60 = f20.iloc[ev].dropna(), f60.iloc[ev].dropna()
        dev = f60.loc[[t for t in idx if t < pd.Timestamp("2025-11-01")]].dropna()
        hold = f60.loc[[t for t in idx if t >= pd.Timestamp("2025-11-01")]].dropna()
        g = lambda x: float(x.mean()) if len(x) else None
        out.append({"name": name, "n": len(ev), "events": [str(t.date()) for t in idx[-8:]], "avg20": g(e20), "avg60": g(e60), "up60": g(e60 > 0) if len(e60) else None, "dev60": g(dev), "devN": int(len(dev)), "hold60": g(hold), "holdN": int(len(hold))})
    a60 = f60[valid].dropna()
    out.append({"name": "隨便哪一天", "n": int(len(a60)), "avg20": float(f20[valid].dropna().mean()), "avg60": float(a60.mean()), "up60": float((a60 > 0).mean())})
    return out


# ---------------------------------------------------------------- 台股組
COMPONENTS_TW = {
    "twMargin": "融資維持率（越低＝斷頭壓力越大）",
    "twMarginChg": "融資餘額 20 日變化（散戶加槓桿）",
    "twForeign": "外資台指期淨未平倉",
    "twRetail": "散戶小台淨多單比（散戶越看多越熱）",
    "twFomo": "台股 FOMO／恐慌（加權指數乖離、動能）",
}


def finmind(dataset: str, data_id: str, start: str) -> pd.DataFrame | None:
    import os

    token = os.environ.get("FINMIND_TOKEN", "")
    raw = http_get(f"https://api.finmindtrade.com/api/v4/data?dataset={dataset}&data_id={data_id}&start_date={start}" + (f"&token={token}" if token else ""), timeout=120)
    if not raw:
        return None
    try:
        j = json.loads(raw)
        if not j.get("data"):
            log(f"  FinMind {dataset} 沒有資料：{str(j.get('msg', ''))[:80]}")
            return None
        return pd.DataFrame(j["data"])
    except Exception as e:
        log(f"  FinMind {dataset} 格式不符：{e}")
        return None


def retail_mtx(start: str) -> pd.Series | None:
    """散戶小台淨部位比＝−（三大法人小台淨未平倉）÷ 全市場小台未平倉。"""
    inst = finmind("TaiwanFuturesInstitutionalInvestors", "MTX", start)
    if inst is None:
        return None
    try:
        inst["net"] = pd.to_numeric(inst["long_open_interest_balance_volume"]) - pd.to_numeric(inst["short_open_interest_balance_volume"])
        retail = -inst.groupby("date")["net"].sum()
        daily = finmind("TaiwanFuturesDaily", "MTX", start)
        if daily is not None and "open_interest" in daily:
            if "trading_session" in daily:
                daily = daily[daily["trading_session"] == "position"]
            oi = daily.groupby("date")["open_interest"].apply(lambda x: pd.to_numeric(x, errors="coerce").sum())
            retail = (retail / oi.reindex(retail.index)).replace([np.inf, -np.inf], np.nan)
        retail.index = pd.to_datetime(retail.index)
        log(f"  FinMind 小台：{retail.notna().sum()} 天")
        return retail.dropna()
    except Exception as e:
        log(f"  散戶小台計算失敗：{e}")
        return None


def build_tw(d: Path, twii: pd.Series) -> tuple[pd.DataFrame, dict[str, str]]:
    days = twii.index
    comp: dict[str, pd.Series] = {}
    src: dict[str, str] = {}
    j = read_json(d / "market-risk.json")
    if j and j.get("rows"):
        df = pd.DataFrame(j["rows"], columns=["date", "ratio", "finAmt", "finLots", "shortLots", "foreignNet"])
        df.index = pd.to_datetime(df.pop("date"))
        df = df.apply(pd.to_numeric, errors="coerce")
        df.loc[df["finAmt"] <= 0, ["finAmt"]] = np.nan
        df = df.reindex(days).ffill(limit=5)
        comp["twMargin"] = pct_rank(df["ratio"])
        comp["twMarginChg"] = pct_rank(df["finAmt"].pct_change(20))
        if df["foreignNet"].notna().sum() > WINDOW:
            comp["twForeign"] = pct_rank(df["foreignNet"])
        src.update(twMargin="market-risk.json", twMarginChg="market-risk.json", twForeign="market-risk.json")
    rt = retail_mtx(str(days[0].date()))
    if rt is not None and len(rt) > WINDOW:
        comp["twRetail"] = pct_rank(rt.reindex(days).ffill(limit=5))
        src["twRetail"] = "FinMind 小台 MTX"
    comp["twFomo"] = pd.concat([pct_rank(twii / twii.rolling(50).mean() - 1), pct_rank(twii.pct_change(20))], axis=1).mean(axis=1, skipna=True)
    src["twFomo"] = "index/TAIEX.json"
    out = pd.DataFrame(comp, index=days)
    for k in COMPONENTS_TW:
        if k not in out:
            log(f"  不用：{COMPONENTS_TW[k]}（沒有資料）")
    return out, src


def us_to_tw(s: pd.Series, tw: pd.DatetimeIndex) -> pd.Series:
    """美國 D 日的數字 → D 日之後的第一個台股交易日（美股週五 → 台股週一）。"""
    s = s.dropna()
    m = pd.merge_asof(pd.DataFrame({"tw": tw}), pd.DataFrame({"us": s.index, "v": s.values}), left_on="tw", right_on="us", direction="backward", allow_exact_matches=False)
    return pd.Series(m["v"].values, index=tw)


def plot(twii: pd.Series, score: pd.Series, us_g: pd.Series, tw_g: pd.Series, path: Path, title: str) -> None:
    import warnings

    warnings.filterwarnings("ignore", category=UserWarning)  # 沒有中文字型時的大量警告
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import font_manager

    for f in ["Noto Sans CJK TC", "Noto Sans TC", "WenQuanYi Zen Hei", "Microsoft JhengHei", "PingFang TC"]:
        if any(f in x.name for x in font_manager.fontManager.ttflist):
            plt.rcParams["font.sans-serif"] = [f]
            break
    plt.rcParams["axes.unicode_minus"] = False
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(14, 8), sharex=True, gridspec_kw={"height_ratios": [3, 2]})
    df = pd.DataFrame({"c": twii, "s": score}).dropna()
    a1.plot(df.index, df.c, color="#333", lw=1.1, label="台灣加權指數")
    lo, hi = df[df.s < BUY], df[df.s > HOT]
    a1.scatter(lo.index, lo.c * 0.975, marker="^", color="#16a34a", s=22, label=f"熱度 < {BUY:.0f}（籌碼乾淨，抄底區）", zorder=3)
    a1.scatter(hi.index, hi.c * 1.025, marker="v", color="#dc2626", s=22, label=f"熱度 > {HOT:.0f}（散戶瘋狂）", zorder=3)
    a1.set_title(title)
    a1.legend(loc="upper left")
    a1.grid(alpha=0.25)
    a2.plot(us_g.index, us_g, color="#94a3b8", lw=0.8, alpha=0.8, label="美股組")
    a2.plot(tw_g.index, tw_g, color="#f59e0b", lw=0.8, alpha=0.8, label="台股組")
    a2.plot(score.index, score, color="#2563eb", lw=1.6, label="台美融資熱度（綜合）")
    a2.axhline(BUY, color="gray", ls="--", lw=1)
    a2.axhline(HOT, color="gray", ls="--", lw=1)
    a2.axhspan(0, BUY, color="#bbf7d0", alpha=0.5)
    a2.axhspan(HOT, 100, color="#fecaca", alpha=0.5)
    a2.set_ylim(0, 100)
    a2.legend(loc="upper left", ncol=3)
    a2.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)


def group_mean(df: pd.DataFrame) -> pd.Series:
    return df.mean(axis=1, skipna=True).where(df.notna().sum(axis=1) >= max(1, (df.shape[1] + 1) // 2))


# ---------------------------------------------------------------- 加權最佳化
H_FWD = 60  # 看「之後 60 個交易日」加權指數的報酬
SHRINK = 0.5  # 最佳權重往等權拉回一半（降低「調到剛好符合過去」）


def weighted(df: pd.DataFrame, w: np.ndarray) -> pd.Series:
    """加權平均；某天缺的元件不算，權重分給其他元件（缺太多就不算）。"""
    m = df.notna().values
    v = np.nan_to_num(df.values)
    den = (m * w).sum(1)
    out = np.where(den > 0.4 * w.sum(), (v * w).sum(1) / np.where(den > 0, den, 1), np.nan)
    return pd.Series(out, index=df.index)


def ic(score: pd.Series, fwd: pd.Series) -> float:
    """熱度越低、之後漲越多 → 回傳正值（等級相關係數，每 5 天取一次，減少重疊）。"""
    x = pd.DataFrame({"s": score, "f": fwd}).dropna().iloc[::5]
    if len(x) < 30:
        return 0.0
    return float(-x["s"].rank().corr(x["f"].rank()))


def optimize(df: pd.DataFrame, fwd: pd.Series, n_random: int = 1500) -> np.ndarray:
    """權重（加總 1）：Dirichlet 隨機搜尋＋Nelder-Mead 微調，目標＝熱度與之後 60 日報酬的負相關最大；再往等權拉回 SHRINK。"""
    from scipy.optimize import minimize

    k = df.shape[1]
    rng = np.random.default_rng(20261123)
    cands = [np.full(k, 1 / k)] + [rng.dirichlet(np.ones(k)) for _ in range(n_random)]
    vals = [ic(weighted(df, w), fwd) for w in cands]
    best = cands[int(np.argmax(vals))]
    res = minimize(lambda z: -ic(weighted(df, np.exp(z) / np.exp(z).sum()), fwd), np.log(best + 1e-6), method="Nelder-Mead", options={"maxiter": 300})
    w = np.exp(res.x) / np.exp(res.x).sum()
    if -res.fun < max(vals):
        w = best
    return (1 - SHRINK) * w + SHRINK * np.full(k, 1 / k)


def walk_forward(df: pd.DataFrame, fwd: pd.Series, close: pd.Series) -> tuple[pd.Series, dict]:
    """每一年只用「之前、而且答案已經揭曉」的資料挑權重，再算那一年的熱度。回傳樣本外熱度與成績。"""
    years = sorted({t.year for t in df.index})[2:]
    parts, ic_opt, ic_eq = [], [], []
    for y in years:
        test = df.index[df.index.year == y]
        start = test[0]
        known = fwd.index[(fwd.index < start)]
        known = known[: max(0, len(known) - H_FWD)]  # 60 日報酬要在測試開始前就揭曉
        train = df.loc[df.index.isin(known)]
        if len(train) < 300:
            continue
        w = optimize(train, fwd.loc[train.index], n_random=500)
        sc = weighted(df, w).loc[test]
        parts.append(sc)
        ic_opt.append(ic(sc, fwd.loc[test]))
        ic_eq.append(ic(weighted(df, np.full(df.shape[1], 1 / df.shape[1])).loc[test], fwd.loc[test]))
        log(f"  {y}：用 {train.index[0].date()}～{train.index[-1].date()} 挑權重，樣本外相關 {ic_opt[-1]:+.3f}（等權 {ic_eq[-1]:+.3f}）")
    oos = pd.concat(parts) if parts else pd.Series(dtype=float)
    return oos, {"years": [str(y) for y in years[: len(ic_opt)]], "ic": ic_opt, "icEqual": ic_eq}


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    d = Path(args[0] if args else "data")
    png = Path(sys.argv[sys.argv.index("--png") + 1]) if "--png" in sys.argv else d / "heat-index.png"
    twii = ohlc(d, "index/TAIEX.json")
    if twii is None:
        sys.exit("沒有加權指數資料（index/TAIEX.json）")
    log("美股組（原始五元件）：")
    spx, us_scores, src_us = build(d)
    log("台股組：")
    tw_scores, src_tw = build_tw(d, twii)
    days = twii.index
    us_tw = pd.DataFrame({k: us_to_tw(us_scores[k], days) for k in us_scores}, index=days)
    us_g = group_mean(us_tw)
    tw_g = group_mean(tw_scores)
    allc = pd.concat([us_tw, tw_scores], axis=1)
    allc = allc.loc[allc.notna().any(axis=1)]
    fwd = twii.shift(-H_FWD) / twii - 1
    log("逐年往前滾挑權重（樣本外）：")
    oos, wf = walk_forward(allc, fwd.reindex(allc.index), twii)
    log("用全部歷史挑最新權重⋯")
    known = allc.index[: max(0, len(allc) - H_FWD)]
    w = optimize(allc.loc[known], fwd.loc[known])
    # 樣本外最佳化沒有贏等權 → 直接用等權（不硬套調出來的權重）
    use_equal = bool(wf["ic"]) and np.mean(wf["ic"]) <= np.mean(wf["icEqual"])
    if use_equal:
        w = np.full(allc.shape[1], 1 / allc.shape[1])
        log("  樣本外最佳化權重沒有贏等權 → 改用等權")
    wf["method"] = "equal" if use_equal else "optimized"
    weights = dict(zip(allc.columns, w))
    score = weighted(allc, w).dropna()
    us_g, tw_g = us_g.reindex(score.index), tw_g.reindex(score.index)

    # 驗證用樣本外熱度（每年只用之前的資料挑權重），比較公正
    ev = event_study(oos if len(oos) and not use_equal else score, twii)
    now, prev = float(score.iloc[-1]), float(score.iloc[-2])
    if now < BUY:
        advice = "籌碼極度乾淨（抄底區）" + ("：熱度開始回升" if now > prev else "：還在往下")
    elif now > HOT:
        advice = "散戶過熱：小心回檔"
    else:
        advice = "中性"
    pct = lambda x: "—" if x is None else f"{x * 100:+.1f}%"
    comps = [("美股", k, COMPONENTS[k], src_us.get(k, ""), us_tw[k]) for k in us_scores] + [("台股", k, COMPONENTS_TW[k], src_tw.get(k, ""), tw_scores[k]) for k in tw_scores]

    log("\n================ 結果 ================")
    log(f"最新熱度：{now:.1f}（前一天 {prev:.1f}），台股 {score.index[-1].date()}　→ {advice}")
    log(f"  美股組 {us_g.iloc[-1]:.1f}、台股組 {tw_g.iloc[-1]:.1f}")
    for g, k, name, src, ser in comps:
        v = ser.dropna()
        log(f"  [{g}] {name:<30} 權重 {weights[k] * 100:5.1f}%   今天 {v.iloc[-1] if len(v) else float('nan'):5.1f}   （{src}）")
    if wf["ic"]:
        log(f"\n樣本外相關（熱度越低、之後 60 日漲越多＝正）：最佳權重平均 {np.mean(wf['ic']):+.3f}、等權平均 {np.mean(wf['icEqual']):+.3f}")
    log(f"\n跌破 {BUY:.0f} 之後的加權指數（共 {len(ev['events'])} 次：{'、'.join(ev['events'][-6:])}{'⋯' if len(ev['events']) > 6 else ''}）")
    for h in ("20", "60"):
        x = ev[h]
        upt = "—" if x["up"] is None else f"{x['up'] * 100:.0f}%"
        log(f"  {h} 日後  平均 {pct(x['avg'])}  上漲機率 {upt}　｜ 隨便哪一天 {pct(x['allAvg'])}、{x['allUp'] * 100:.0f}%")

    mr = read_json(d / "market-risk.json")
    ratio = None
    if mr and mr.get("rows"):
        ratio = pd.Series({pd.Timestamp(r[0]): r[1] for r in mr["rows"] if r[1]}, dtype=float)
    rules = rule_study(oos if len(oos) and not use_equal else score, twii, ratio)
    pf = lambda x: "  —  " if x is None else f"{x * 100:+5.1f}%"
    log("\n找底規則比較（樣本外熱度；之後的加權指數報酬）：")
    for r in rules:
        upt = "—" if r["up60"] is None else f"{r['up60'] * 100:.0f}%"
        log(f"  {r['name']:<28} {r['n']:>4} 次  20 日 {pf(r['avg20'])}  60 日 {pf(r['avg60'])}  上漲 {upt}" + (f"｜開發期 {pf(r['dev60'])}（{r['devN']}）保留期 {pf(r['hold60'])}（{r['holdN']}）" if 'devN' in r else ""))
    plot(twii, score, us_g, tw_g, png, f"台美融資熱度（美股原始五元件＋台股籌碼）　最新 {now:.0f}（{score.index[-1].date()}）")
    log(f"\n圖：{png}")
    tail = score.index[score.index >= score.index[-1] - pd.Timedelta(days=365 * 3)]
    r1 = lambda x: None if not np.isfinite(x) else round(float(x), 1)
    out = {
        "generatedAt": pd.Timestamp.now(tz="UTC").isoformat(),
        "kind": "tw-us-margin",
        "asOf": str(score.index[-1].date()),
        "thresholds": {"buy": BUY, "hot": HOT},
        "now": round(now, 1),
        "prev": round(prev, 1),
        "usNow": r1(us_g.iloc[-1]),
        "twNow": r1(tw_g.iloc[-1]),
        "advice": advice,
        "components": [{"group": g, "id": k, "name": name, "source": src, "weight": round(float(weights[k]), 4), "score": r1(ser.dropna().iloc[-1]) if ser.notna().any() else None} for g, k, name, src, ser in comps],
        "missing": [COMPONENTS[k] for k in COMPONENTS if k not in us_scores] + [COMPONENTS_TW[k] for k in COMPONENTS_TW if k not in tw_scores],
        "events": {"tw": ev},
        "rules": rules,
        "weighting": {"horizon": H_FWD, "shrink": SHRINK, **wf},
        # [台股日期, 加權指數, 綜合熱度, 美股組, 台股組]
        "series": [[str(t.date()), round(float(twii.loc[t]), 2), r1(score.loc[t]), r1(us_g.loc[t]), r1(tw_g.loc[t])] for t in tail],
    }
    (d / "heat-index.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    log(f"輸出：{d / 'heat-index.json'}")


if __name__ == "__main__":
    main()
