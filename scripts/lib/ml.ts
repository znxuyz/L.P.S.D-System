/**
 * 預測用的小型機器學習工具（不依賴外部套件）：
 * - ridge：嶺迴歸（線性迴歸＋L2），係數就是每個因子的權重，方便解釋「為什麼」。
 * - logistic：邏輯迴歸（L2，牛頓法），輸出上漲機率。
 * - 標準化、排名、Spearman 排名相關係數（IC）。
 */

/** 解 A x = b（A 為 n×n，高斯消去＋部分選主元）。 */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}

/** 嶺迴歸：回傳 [截距, ...係數]。X 的每一列是一筆樣本（不含截距）；截距不加懲罰。 */
export function ridge(X: ArrayLike<number>[], y: ArrayLike<number>, lambda: number, w?: ArrayLike<number>): number[] {
  const k = X[0]?.length ?? 0;
  const n = k + 1;
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  const row = new Array(n);
  for (let i = 0; i < X.length; i++) {
    const wi = w ? w[i] : 1;
    row[0] = 1;
    for (let j = 0; j < k; j++) row[j + 1] = X[i][j];
    for (let a = 0; a < n; a++) {
      const ra = row[a] * wi;
      b[a] += ra * y[i];
      for (let c = a; c < n; c++) A[a][c] += ra * row[c];
    }
  }
  for (let a = 0; a < n; a++) for (let c = 0; c < a; c++) A[a][c] = A[c][a];
  const m = X.length || 1;
  for (let j = 1; j < n; j++) A[j][j] += lambda * m;
  return solve(A, b);
}

export const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/** 邏輯迴歸（L2，牛頓法）：回傳 [截距, ...係數]；y 是 0／1。 */
export function logistic(X: ArrayLike<number>[], y: ArrayLike<number>, lambda: number, iters = 25): number[] {
  const k = X[0]?.length ?? 0;
  const n = k + 1;
  let beta = new Array(n).fill(0);
  const m = X.length || 1;
  const row = new Array(n);
  for (let it = 0; it < iters; it++) {
    const H = Array.from({ length: n }, () => new Array(n).fill(0));
    const g = new Array(n).fill(0);
    for (let i = 0; i < X.length; i++) {
      row[0] = 1;
      for (let j = 0; j < k; j++) row[j + 1] = X[i][j];
      let z = 0;
      for (let a = 0; a < n; a++) z += beta[a] * row[a];
      const p = sigmoid(z);
      const wv = Math.max(p * (1 - p), 1e-6);
      for (let a = 0; a < n; a++) {
        g[a] += (p - y[i]) * row[a];
        for (let c = a; c < n; c++) H[a][c] += wv * row[a] * row[c];
      }
    }
    for (let a = 0; a < n; a++) for (let c = 0; c < a; c++) H[a][c] = H[c][a];
    for (let j = 1; j < n; j++) {
      H[j][j] += lambda * m;
      g[j] += lambda * m * beta[j];
    }
    const step = solve(H, g);
    let moved = 0;
    beta = beta.map((v, i) => {
      moved = Math.max(moved, Math.abs(step[i]));
      return v - step[i];
    });
    if (moved < 1e-7) break;
  }
  return beta;
}

export const dot = (beta: number[], x: ArrayLike<number>) => {
  let z = beta[0];
  for (let j = 0; j < x.length; j++) z += beta[j + 1] * x[j];
  return z;
};

/** 排名換成 -0.5～0.5（同分取平均名次）；NaN 換成 0（中間）。 */
export function rankCenter(v: ArrayLike<number>): Float64Array {
  const n = v.length;
  const out = new Float64Array(n);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(v[i])) idx.push(i);
  idx.sort((a, b) => v[a] - v[b]);
  const m = idx.length;
  if (m < 2) return out;
  for (let s = 0; s < m; ) {
    let e = s;
    while (e + 1 < m && v[idx[e + 1]] === v[idx[s]]) e++;
    const r = (s + e) / 2 / (m - 1) - 0.5;
    for (let t = s; t <= e; t++) out[idx[t]] = r;
    s = e + 1;
  }
  return out;
}

/** Spearman 排名相關係數（只算兩邊都有值的）。 */
export function spearman(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const ia: number[] = [];
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) ia.push(i);
  if (ia.length < 10) return NaN;
  const ra = rankCenter(ia.map((i) => a[i]));
  const rb = rankCenter(ia.map((i) => b[i]));
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < ra.length; i++) {
    sab += ra[i] * rb[i];
    saa += ra[i] * ra[i];
    sbb += rb[i] * rb[i];
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : NaN;
}

/** 依訓練資料算平均與標準差，回傳把一列資料標準化的函式（缺值當 0＝平均）。 */
export function standardizer(X: ArrayLike<number>[]): { mean: number[]; sd: number[]; apply: (x: ArrayLike<number>) => number[] } {
  const k = X[0]?.length ?? 0;
  const mean = new Array(k).fill(0);
  const sd = new Array(k).fill(0);
  const cnt = new Array(k).fill(0);
  for (const x of X) for (let j = 0; j < k; j++) if (Number.isFinite(x[j])) (mean[j] += x[j]), cnt[j]++;
  for (let j = 0; j < k; j++) mean[j] /= cnt[j] || 1;
  for (const x of X) for (let j = 0; j < k; j++) if (Number.isFinite(x[j])) sd[j] += (x[j] - mean[j]) ** 2;
  for (let j = 0; j < k; j++) sd[j] = Math.sqrt(sd[j] / Math.max(1, cnt[j] - 1)) || 1;
  const apply = (x: ArrayLike<number>) => {
    const out = new Array(k);
    // 截斷在 ±4 個標準差，避免極端值主導
    for (let j = 0; j < k; j++) out[j] = Number.isFinite(x[j]) ? Math.max(-4, Math.min(4, (x[j] - mean[j]) / sd[j])) : 0;
    return out;
  };
  return { mean, sd, apply };
}

/** 平均、標準差。 */
export const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
export const std = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1));
};
/** 最大回落（輸入是淨值序列）。 */
export function maxDrawdown(equity: number[]): number {
  let peak = -Infinity;
  let dd = 0;
  for (const v of equity) {
    peak = Math.max(peak, v);
    dd = Math.min(dd, v / peak - 1);
  }
  return dd;
}
