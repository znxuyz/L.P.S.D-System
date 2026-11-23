#!/usr/bin/env python3
"""
台美聯動籌碼熱度指數（Taiwan-US Co-Movement Credit Heat Index）

    python3 scripts/heat_index.py <資料資料夾> [--png 輸出圖檔]

把美股的「總經流動性、恐慌情緒」和台股的「散戶籌碼、斷頭（融資維持率）」融合成 0～100 分：
0 分＝市場最恐慌（最適合抄底），100 分＝市場最狂熱（風險最高）。

資料（每一項都先找資料夾裡已經收集好的，沒有才連網抓）：
  - 加權指數          index/TAIEX.json          （沒有就用 Yahoo ^TWII）
  - VIX               us/VIX.json               （沒有就用 Yahoo ^VIX）
  - 融資維持率、融資餘額、外資台指期淨未平倉  market-risk.json
  - 聯準會總資產 WALCL、財政部 TGA WTREGEN    FRED（fredgraph.csv，免金鑰）
  - 散戶小台多空比    FinMind（TaiwanFuturesInstitutionalInvestors＋TaiwanFuturesDaily，小台 MTX）
                      散戶淨部位＝−（三大法人小台淨未平倉），除以全市場小台未平倉
  抓不到的指標就不用（權重自動分給其他指標），不會讓整支程式失敗。

時間對齊（不偷看）：以台股交易日為準。
  - 美股（VIX）：美國 D 日收盤，算進台股「D 日之後的第一個交易日」（美股週五 → 台股週一）。
  - FRED 週資料（週三的數字，週四美東下午公布）：從觀測日 + 2 天起才算知道。
  - 台股資料：當天收盤後算出分數，用在「隔天」的部位（不會用當天收盤價成交當天的訊號）。

標準化：每個指標用「過去 252 個交易日」的百分位數（0～100），只用當天以前的資料。
反向指標（VIX）倒過來：VIX 越高分數越低。

回測與最佳化：
  - 策略：熱度 < 買進門檻（25）而且比前一天高（勾頭向上）→ 全部買進加權指數；
          熱度 > 賣出門檻（80）→ 減碼到一半；熱度 > 90 → 全部出場。扣交易成本（來回 0.3%）。
  - 權重：在「各指標權重加總 100%」的範圍裡隨機搜尋＋局部最佳化，目標是夏普值最大。
  - 最佳化很容易「調到剛好符合過去」：所以成績一律用「逐年往前滾」計算——每一年只用那一年以前的資料挑權重，
    再拿去跑那一年。印出的「最新權重」是用全部歷史挑的（給現在用），但它的成績不能當真，要看逐年往前滾的成績。

輸出：<資料資料夾>/heat-index.json（網站預測頁用）、圖檔（--png，預設 <資料資料夾>/heat-index.png）。
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

BUY_TH = 25.0
SELL_TH = 80.0
EXIT_TH = 90.0
WINDOW = 252
COST = 0.003  # 加權指數（ETF）來回成本：手續費 0.1425% × 2 ＋ 證交稅 0.1%，取整
SEED = 20261123
UA = {"User-Agent": "Mozilla/5.0 (heat-index research script)"}


def log(*a: object) -> None:
    print(*a, flush=True)


# ---------------------------------------------------------------- 資料
def http_get(url: str, timeout: int = 60) -> bytes | None:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
            return r.read()
    except Exception as e:  # 網路不通、被擋：這個指標就不用
        log(f"  抓不到 {url.split('?')[0]}：{e}")
        return None


def yahoo(symbol: str) -> pd.Series | None:
    raw = http_get(f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.request.quote(symbol)}?range=10y&interval=1d")
    if not raw:
        return None
    try:
        j = json.loads(raw)["chart"]["result"][0]
        ts = pd.to_datetime(j["timestamp"], unit="s").normalize()
        return pd.Series(j["indicators"]["quote"][0]["close"], index=ts, dtype=float).dropna()
    except Exception as e:
        log(f"  Yahoo {symbol} 格式不符：{e}")
        return None


def fred(series_id: str) -> pd.Series | None:
    raw = http_get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}")
    if not raw:
        return None
    try:
        df = pd.read_csv(io.BytesIO(raw))
        df.columns = ["date", "v"]
        df["v"] = pd.to_numeric(df["v"], errors="coerce")
        return pd.Series(df["v"].values, index=pd.to_datetime(df["date"])).dropna()
    except Exception as e:
        log(f"  FRED {series_id} 格式不符：{e}")
        return None


def finmind(dataset: str, data_id: str, start: str) -> pd.DataFrame | None:
    token = os.environ.get("FINMIND_TOKEN", "")
    url = f"https://api.finmindtrade.com/api/v4/data?dataset={dataset}&data_id={data_id}&start_date={start}" + (f"&token={token}" if token else "")
    raw = http_get(url, timeout=120)
    if not raw:
        return None
    try:
        j = json.loads(raw)
        if j.get("status") not in (200, None) or not j.get("data"):
            log(f"  FinMind {dataset} 沒有資料：{str(j.get('msg', ''))[:80]}")
            return None
        return pd.DataFrame(j["data"])
    except Exception as e:
        log(f"  FinMind {dataset} 格式不符：{e}")
        return None


def read_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def load_taiex(d: Path) -> pd.Series:
    rows = read_json(d / "index" / "TAIEX.json")
    if rows:
        return pd.Series([r[4] for r in rows], index=pd.to_datetime([r[0] for r in rows]), dtype=float)
    s = yahoo("^TWII")
    if s is None:
        sys.exit("沒有加權指數資料（index/TAIEX.json 或 Yahoo ^TWII）")
    return s


def load_vix(d: Path) -> pd.Series | None:
    rows = read_json(d / "us" / "VIX.json")
    if rows:
        return pd.Series([r[4] for r in rows], index=pd.to_datetime([r[0] for r in rows]), dtype=float)
    return yahoo("^VIX")


def load_market_risk(d: Path) -> pd.DataFrame | None:
    j = read_json(d / "market-risk.json")
    if not j or not j.get("rows"):
        return None
    df = pd.DataFrame(j["rows"], columns=["date", "ratio", "finAmt", "finLots", "shortLots", "foreignNet"])
    df.index = pd.to_datetime(df.pop("date"))
    df = df.apply(pd.to_numeric, errors="coerce")
    df.loc[df["finAmt"] <= 0, ["finAmt", "finLots", "shortLots"]] = np.nan  # 當天還沒公布
    return df


def load_retail_mtx(start: str) -> pd.Series | None:
    """散戶小台淨部位比＝−（三大法人小台淨未平倉）÷ 全市場小台未平倉。"""
    inst = finmind("TaiwanFuturesInstitutionalInvestors", "MTX", start)
    if inst is None:
        return None
    daily = finmind("TaiwanFuturesDaily", "MTX", start)
    try:
        inst["net"] = pd.to_numeric(inst["long_open_interest_balance_volume"]) - pd.to_numeric(inst["short_open_interest_balance_volume"])
        inst_net = inst.groupby("date")["net"].sum()
        if daily is not None:
            daily = daily[daily.get("trading_session", "position") == "position"] if "trading_session" in daily else daily
            oi = daily.groupby("date")["open_interest"].apply(lambda x: pd.to_numeric(x, errors="coerce").sum())
        else:
            oi = None
        retail = -inst_net
        if oi is not None:
            retail = (retail / oi.reindex(retail.index)).replace([np.inf, -np.inf], np.nan)
        retail.index = pd.to_datetime(retail.index)
        return retail.dropna()
    except Exception as e:
        log(f"  散戶小台計算失敗：{e}")
        return None


# ---------------------------------------------------------------- 對齊
def align_us(s: pd.Series, tw: pd.DatetimeIndex, lag_days: int = 0) -> pd.Series:
    """美國的資料（觀測日＋lag_days 才算知道）→ 算進「之後的第一個台股交易日」。"""
    avail = s.copy()
    avail.index = avail.index + timedelta(days=lag_days)
    left = pd.DataFrame({"tw": tw})
    right = pd.DataFrame({"t": avail.index, "v": avail.values}).sort_values("t")
    # 台股 T 日開盤前知道的：美國 < T 日的最新一筆（allow_exact_matches=False → 嚴格早於）
    m = pd.merge_asof(left, right, left_on="tw", right_on="t", direction="backward", allow_exact_matches=False)
    return pd.Series(m["v"].values, index=tw)


def align_tw(s: pd.Series, tw: pd.DatetimeIndex) -> pd.Series:
    return s.reindex(tw).ffill(limit=5)


def rolling_pct(s: pd.Series, window: int = WINDOW, invert: bool = False) -> pd.Series:
    """當天的值在過去 window 天（含當天）裡的百分位數（0～100），只用當天以前的資料。"""
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


# ---------------------------------------------------------------- 指標
INDICATORS = {
    "vix": ("VIX 恐慌指數（反向：越恐慌分數越低）", "美股"),
    "liquidity": ("美元淨流動性（聯準會總資產 − 財政部 TGA，13 週變化）", "美股"),
    "retail": ("散戶小台淨多單比（散戶越看多越熱）", "台股"),
    "margin": ("全市場融資維持率（暴跌＝斷頭）", "台股"),
    "marginChg": ("融資餘額 20 日變化（散戶加槓桿）", "台股（自行加入）"),
    "foreign": ("外資台指期淨未平倉", "台股（自行加入）"),
    "trend": ("加權指數離 200 日均線", "台股（自行加入）"),
}


def build(d: Path) -> tuple[pd.Series, pd.DataFrame, dict]:
    taiex = load_taiex(d).sort_index()
    tw = taiex.index
    raw: dict[str, pd.Series] = {}
    src: dict[str, str] = {}

    vix = load_vix(d)
    if vix is not None:
        raw["vix"] = align_us(vix, tw)
        src["vix"] = "us/VIX.json" if (d / "us" / "VIX.json").exists() else "Yahoo ^VIX"

    walcl, tga = fred("WALCL"), fred("WTREGEN")
    if walcl is not None and tga is not None:
        net = (walcl - tga.reindex(walcl.index, method="ffill")).dropna()
        chg = net.pct_change(13)  # 13 週變化
        raw["liquidity"] = align_us(chg, tw, lag_days=2)
        src["liquidity"] = "FRED WALCL、WTREGEN"

    mr = load_market_risk(d)
    if mr is not None:
        raw["margin"] = align_tw(mr["ratio"], tw)
        raw["marginChg"] = align_tw(mr["finAmt"].ffill().pct_change(20), tw)
        raw["foreign"] = align_tw(mr["foreignNet"], tw)
        src.update(margin="market-risk.json", marginChg="market-risk.json", foreign="market-risk.json")

    retail = load_retail_mtx(str(tw[0].date()))
    if retail is not None and len(retail) > WINDOW:
        raw["retail"] = align_tw(retail, tw)
        src["retail"] = "FinMind 小台 MTX"

    ma = taiex.rolling(200).mean()
    raw["trend"] = taiex / ma - 1
    src["trend"] = "index/TAIEX.json"

    scores = pd.DataFrame({k: rolling_pct(v, invert=(k == "vix")) for k, v in raw.items()}, index=tw)
    keep = [k for k in INDICATORS if k in scores and scores[k].notna().sum() > WINDOW]
    for k in set(INDICATORS) - set(keep):
        log(f"  不用：{INDICATORS[k][0]}（沒有資料）")
    return taiex, scores[keep], src


# ---------------------------------------------------------------- 回測
def composite(scores: pd.DataFrame, w: np.ndarray) -> pd.Series:
    """加權平均；某天缺的指標不算，權重分給其他指標。"""
    m = scores.notna().values
    v = np.nan_to_num(scores.values)
    num = (v * w).sum(1)
    den = (m * w).sum(1)
    out = np.where(den > 0.3 * w.sum(), num / np.where(den > 0, den, 1), np.nan)
    return pd.Series(out, index=scores.index)


def positions(score: pd.Series) -> np.ndarray:
    s = score.values
    pos = np.zeros(len(s))
    p = 0.0
    for i in range(len(s)):
        x = s[i]
        if np.isfinite(x):
            prev = s[i - 1] if i else np.nan
            if p < 1 and x < BUY_TH and np.isfinite(prev) and x > prev:
                p = 1.0
            elif p > 0 and x > EXIT_TH:
                p = 0.0
            elif p > 0.5 and x > SELL_TH:
                p = 0.5
        pos[i] = p
    return pos


def run(score: pd.Series, ret: pd.Series) -> pd.Series:
    """收盤算出分數 → 部位用在隔天的報酬；換部位扣成本。"""
    pos = pd.Series(positions(score), index=score.index)
    held = pos.shift(1).fillna(0)
    turn = held.diff().abs().fillna(held.abs())
    return held * ret - turn * COST / 2


def stats(r: pd.Series) -> dict:
    r = r.dropna()
    if len(r) < 20:
        return {"ret": 0.0, "cagr": 0.0, "sharpe": 0.0, "mdd": 0.0, "days": int(len(r))}
    eq = (1 + r).cumprod()
    yrs = len(r) / 252
    sd = r.std()
    return {
        "ret": float(eq.iloc[-1] - 1),
        "cagr": float(eq.iloc[-1] ** (1 / yrs) - 1) if yrs > 0 else 0.0,
        "sharpe": float(r.mean() / sd * np.sqrt(252)) if sd > 0 else 0.0,
        "mdd": float((eq / eq.cummax() - 1).min()),
        "days": int(len(r)),
    }


def optimize(scores: pd.DataFrame, ret: pd.Series, n_random: int = 1500) -> np.ndarray:
    """權重（加總 1）：Dirichlet 隨機搜尋，再用 Nelder-Mead 在最好的附近微調；目標＝夏普值。"""
    from scipy.optimize import minimize

    k = scores.shape[1]
    rng = np.random.default_rng(SEED)

    def sharpe(w: np.ndarray) -> float:
        r = run(composite(scores, w), ret)
        s = stats(r)
        # 太少出手的設定（例如幾年只買一次）不可靠：持有天數少於 10% 就扣分
        held = (r != 0).mean()
        return s["sharpe"] - (0.5 if held < 0.1 else 0.0)

    cands = [np.full(k, 1 / k)] + [rng.dirichlet(np.ones(k)) for _ in range(n_random)]
    vals = [sharpe(w) for w in cands]
    best = cands[int(np.argmax(vals))]

    def obj(z: np.ndarray) -> float:
        w = np.exp(z) / np.exp(z).sum()
        return -sharpe(w)

    res = minimize(obj, np.log(best + 1e-6), method="Nelder-Mead", options={"maxiter": 200, "xatol": 1e-3, "fatol": 1e-4})
    w2 = np.exp(res.x) / np.exp(res.x).sum()
    return w2 if -res.fun >= max(vals) else best


def walk_forward(scores: pd.DataFrame, ret: pd.Series, first_test_year: int) -> tuple[pd.Series, pd.Series, dict]:
    """每一年只用之前的資料挑權重，再跑那一年。回傳樣本外報酬、樣本外熱度、每年用的權重。"""
    years = sorted({d.year for d in scores.index if d.year >= first_test_year})
    oos_r, oos_s, used = [], [], {}
    for y in years:
        train = scores.index[scores.index.year < y]
        test = scores.index[scores.index.year == y]
        if len(train) < WINDOW * 1.5 or not len(test):
            continue
        w = optimize(scores.loc[train], ret.loc[train], n_random=600)
        used[str(y)] = w
        # 分數要從訓練期最後幾天接起來（勾頭向上要看前一天）
        sc = composite(scores, w)
        seg = sc.loc[: test[-1]]
        r = run(seg, ret.loc[seg.index]).loc[test]
        oos_r.append(r)
        oos_s.append(sc.loc[test])
        log(f"  {y}：用 {train[0].date()}～{train[-1].date()} 挑的權重，{len(test)} 天")
    return pd.concat(oos_r), pd.concat(oos_s), used


def buckets(score: pd.Series, close: pd.Series, h: int = 20) -> list[dict]:
    """熱度分組之後 h 個交易日的加權指數報酬（「預測」：歷史上這個熱度之後通常怎麼走）。"""
    fwd = close.shift(-h) / close - 1
    df = pd.DataFrame({"s": score, "f": fwd}).dropna()
    out = []
    for lo, hi, name in [(0, BUY_TH, f"< {BUY_TH:.0f}（恐慌）"), (BUY_TH, 50, "25～50"), (50, SELL_TH, "50～80"), (SELL_TH, 101, f"> {SELL_TH:.0f}（狂熱）")]:
        g = df[(df.s >= lo) & (df.s < hi)]
        out.append({"name": name, "lo": lo, "hi": hi, "n": int(len(g)), "avg": float(g.f.mean()) if len(g) else None, "up": float((g.f > 0).mean()) if len(g) else None})
    base = {"name": "全部日子", "n": int(len(df)), "avg": float(df.f.mean()), "up": float((df.f > 0).mean())}
    return out + [base]


# ---------------------------------------------------------------- 圖
def plot(close: pd.Series, score: pd.Series, path: Path, title: str) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import font_manager

    for f in ["Noto Sans CJK TC", "Noto Sans TC", "WenQuanYi Zen Hei", "Microsoft JhengHei", "PingFang TC", "Heiti TC"]:
        if any(f in x.name for x in font_manager.fontManager.ttflist):
            plt.rcParams["font.sans-serif"] = [f]
            break
    plt.rcParams["axes.unicode_minus"] = False
    df = pd.DataFrame({"c": close, "s": score}).dropna()
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(14, 8), sharex=True, gridspec_kw={"height_ratios": [3, 2]})
    a1.plot(df.index, df.c, color="#333", lw=1.1, label="加權指數")
    lo = df[df.s < BUY_TH]
    hi = df[df.s > SELL_TH]
    a1.scatter(lo.index, lo.c * 0.97, marker="^", color="#16a34a", s=28, label=f"熱度 < {BUY_TH:.0f}（恐慌，抄底區）", zorder=3)
    a1.scatter(hi.index, hi.c * 1.03, marker="v", color="#dc2626", s=28, label=f"熱度 > {SELL_TH:.0f}（狂熱，頂部風險）", zorder=3)
    a1.set_title(title)
    a1.legend(loc="upper left")
    a1.grid(alpha=0.25)
    a2.plot(df.index, df.s, color="#2563eb", lw=1.1, label="台美聯動籌碼熱度指數")
    a2.axhline(BUY_TH, color="gray", ls="--", lw=1)
    a2.axhline(SELL_TH, color="gray", ls="--", lw=1)
    a2.axhspan(0, BUY_TH, color="#bbf7d0", alpha=0.5, label="恐慌區（買進區）")
    a2.axhspan(SELL_TH, 100, color="#fecaca", alpha=0.5, label="狂熱區（風險區）")
    a2.set_ylim(0, 100)
    a2.legend(loc="upper left")
    a2.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


# ---------------------------------------------------------------- 主程式
def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    d = Path(args[0] if args else "data")
    png = Path(sys.argv[sys.argv.index("--png") + 1]) if "--png" in sys.argv else d / "heat-index.png"
    log("台美聯動籌碼熱度指數：讀資料⋯")
    close, scores, src = build(d)
    ret = close.pct_change().fillna(0)
    ok = scores.dropna(how="all").index
    scores = scores.loc[ok[0] :]
    names = list(scores.columns)
    log(f"  指標 {len(names)} 個：{'、'.join(INDICATORS[k][0] for k in names)}")
    log(f"  期間 {scores.index[0].date()} ～ {scores.index[-1].date()}（{len(scores)} 天）")

    log("逐年往前滾（樣本外）⋯")
    first = scores.index[0].year + 2
    oos_r, oos_s, used = walk_forward(scores, ret.loc[scores.index], first)
    bh = ret.loc[oos_r.index]
    s_oos, s_bh = stats(oos_r), stats(bh)

    log("用全部歷史挑最新權重⋯")
    w = optimize(scores, ret.loc[scores.index])
    full = composite(scores, w)
    s_in = stats(run(full, ret.loc[scores.index]))

    last = full.dropna()
    now, prev = float(last.iloc[-1]), float(last.iloc[-2])
    if now < BUY_TH:
        advice = "恐慌區：" + ("勾頭向上，策略訊號＝買進" if now > prev else "還在往下，等勾頭向上再買")
    elif now > EXIT_TH:
        advice = "極度狂熱：策略訊號＝全部出場"
    elif now > SELL_TH:
        advice = "狂熱區：策略訊號＝減碼到一半"
    else:
        advice = "中性區：維持目前部位"
    pos_now = positions(full)[-1]

    pct = lambda x: f"{x * 100:+.1f}%"
    log("\n================ 結果 ================")
    log("最新權重（用全部歷史挑的，加總 100%）：")
    for k, x in sorted(zip(names, w), key=lambda t: -t[1]):
        log(f"  {INDICATORS[k][0]:<36} {x * 100:5.1f}%   今天 {scores[k].dropna().iloc[-1]:5.1f} 分")
    log(f"\n最新熱度：{now:.1f} 分（前一天 {prev:.1f}），{last.index[-1].date()} 收盤")
    log(f"交易建議：{advice}（策略目前部位 {pos_now * 100:.0f}%）")
    log(f"\n樣本外（{oos_r.index[0].date()}～{oos_r.index[-1].date()}，每年只用之前的資料挑權重）：")
    log(f"  策略  總報酬 {pct(s_oos['ret'])}  年化 {pct(s_oos['cagr'])}  夏普 {s_oos['sharpe']:.2f}  最大回落 {pct(s_oos['mdd'])}")
    log(f"  一直持有加權指數  總報酬 {pct(s_bh['ret'])}  年化 {pct(s_bh['cagr'])}  夏普 {s_bh['sharpe']:.2f}  最大回落 {pct(s_bh['mdd'])}")
    log(f"（樣本內，用全部歷史挑權重再回測同一段：夏普 {s_in['sharpe']:.2f}、總報酬 {pct(s_in['ret'])}——看過答案，偏樂觀）")
    bk = buckets(oos_s, close)
    log("\n熱度分組之後 20 個交易日加權指數（樣本外熱度）：")
    for b in bk:
        if b["n"]:
            log(f"  {b['name']:<12} {b['n']:>5} 天  平均 {pct(b['avg'])}  上漲機率 {b['up'] * 100:.0f}%")

    plot(close, full, png, f"台美聯動籌碼熱度指數　最新 {now:.0f} 分（{last.index[-1].date()}）")
    log(f"\n圖：{png}")

    tail = full.index[-756:]
    out = {
        "generatedAt": pd.Timestamp.now(tz="UTC").isoformat(),
        "asOf": str(last.index[-1].date()),
        "thresholds": {"buy": BUY_TH, "sell": SELL_TH, "exit": EXIT_TH},
        "now": round(now, 1),
        "prev": round(prev, 1),
        "advice": advice,
        "position": pos_now,
        "indicators": [
            {"id": k, "name": INDICATORS[k][0], "group": INDICATORS[k][1], "source": src.get(k, ""), "weight": round(float(x), 4), "score": round(float(scores[k].dropna().iloc[-1]), 1)}
            for k, x in zip(names, w)
        ],
        "missing": [INDICATORS[k][0] for k in INDICATORS if k not in names],
        "oos": {"from": str(oos_r.index[0].date()), "to": str(oos_r.index[-1].date()), "strategy": s_oos, "buyHold": s_bh},
        "inSample": s_in,
        "yearWeights": {y: {k: round(float(x), 3) for k, x in zip(names, ww)} for y, ww in used.items()},
        "buckets": bk,
        "series": [[str(i.date()), round(float(close.loc[i]), 2), None if not np.isfinite(full.loc[i]) else round(float(full.loc[i]), 1)] for i in tail],
    }
    (d / "heat-index.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    log(f"輸出：{d / 'heat-index.json'}")


if __name__ == "__main__":
    main()
