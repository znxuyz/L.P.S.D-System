/**
 * 股市入門：K 棒、K 線圖、均線、成交量、型態、指標、基本面、籌碼、下單規則的白話說明。
 *
 * - 圖都是示意（固定亂數產生的走勢），不是真實行情。
 * - 「K 棒實驗室」可以拉開高低收，看 K 棒怎麼變、代表什麼意思。
 * - 顏色跟著漲跌配色設定（var(--up)／var(--down)）。
 */

interface Bar {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** 一根 K 棒的 SVG（x 是中心、y 用 sy 換算）。 */
function candle(x: number, b: Pick<Bar, 'o' | 'h' | 'l' | 'c'>, sy: (p: number) => number, w: number): string {
  const cls = b.c > b.o ? 'k-up' : b.c < b.o ? 'k-down' : 'k-flat';
  const top = sy(Math.max(b.o, b.c));
  const bot = sy(Math.min(b.o, b.c));
  return `<g class="${cls}"><line x1="${r1(x)}" x2="${r1(x)}" y1="${r1(sy(b.h))}" y2="${r1(sy(b.l))}"/><rect x="${r1(x - w / 2)}" y="${r1(top)}" width="${r1(w)}" height="${r1(Math.max(1.2, bot - top))}" rx="${w > 10 ? 2 : 0.5}"/></g>`;
}

/** 固定種子的亂數（每次打開畫面都一樣）。 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** 示意走勢：先小跌、盤整、再上漲、高檔震盪、最後下跌。 */
function demoSeries(n = 120): Bar[] {
  const rnd = rng(20240607);
  const out: Bar[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const phase = i / n;
    const drift = phase < 0.17 ? -0.5 : phase < 0.27 ? 0.1 : phase < 0.6 ? 0.55 : phase < 0.75 ? 0 : -0.6;
    const o = p * (1 + (rnd() - 0.5) * 0.012);
    const c = o * (1 + (drift + (rnd() - 0.5) * 3.2) / 100);
    const h = Math.max(o, c) * (1 + rnd() * 0.012);
    const l = Math.min(o, c) * (1 - rnd() * 0.012);
    const v = 2000 + rnd() * 2500 + Math.abs(c - o) / o * 120000 + (drift > 0 ? 900 : 0);
    out.push({ o, h, l, c, v });
    p = c;
  }
  return out;
}

/** 每 n 根合成一根（日 K → 週 K）。 */
function merge(bars: Bar[], n: number): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < bars.length; i += n) {
    const g = bars.slice(i, i + n);
    out.push({ o: g[0].o, c: g.at(-1)!.c, h: Math.max(...g.map((b) => b.h)), l: Math.min(...g.map((b) => b.l)), v: g.reduce((a, b) => a + b.v, 0) });
  }
  return out;
}

function ma(bars: Bar[], n: number): (number | null)[] {
  return bars.map((_, i) => (i < n - 1 ? null : bars.slice(i - n + 1, i + 1).reduce((a, b) => a + b.c, 0) / n));
}

/** K 線圖＋均線＋成交量。 */
function klineSvg(all: Bar[], opts: { mas: [number, string][]; marks?: boolean; from?: number }): string {
  // 均線用完整資料算（前面的資料當暖身），只畫 from 之後的 K 棒
  const from = opts.from ?? 0;
  const bars = all.slice(from);
  const W = 640;
  const H = 300;
  const VH = 70;
  const pad = 8;
  const top = 10;
  const ph = H - VH - top - 18;
  const hi = Math.max(...bars.map((b) => b.h));
  const lo = Math.min(...bars.map((b) => b.l));
  const sy = (p: number) => top + ((hi - p) / (hi - lo)) * ph;
  const step = (W - pad * 2) / bars.length;
  const x = (i: number) => pad + step * (i + 0.5);
  const vmax = Math.max(...bars.map((b) => b.v));
  const vy0 = H - 4;
  let s = '';
  // 成交量
  s += bars
    .map((b, i) => {
      const h = (b.v / vmax) * (VH - 8);
      return `<rect class="${b.c >= b.o ? 'v-up' : 'v-down'}" x="${r1(x(i) - step * 0.35)}" y="${r1(vy0 - h)}" width="${r1(step * 0.7)}" height="${r1(h)}"/>`;
    })
    .join('');
  s += `<text class="ln-lab" x="${pad}" y="${H - VH + 6}">成交量</text>`;
  s += bars.map((b, i) => candle(x(i), b, sy, Math.max(1.5, step * 0.66))).join('');
  const lines = opts.mas.map(([n]) => ma(all, n).slice(from));
  opts.mas.forEach(([, cls], k) => {
    const pts = lines[k].map((v, i) => (v == null ? '' : `${r1(x(i))},${r1(Math.min(top + ph, Math.max(top, sy(v))))}`)).filter(Boolean);
    s += `<polyline class="ma ${cls}" points="${pts.join(' ')}"/>`;
  });
  // 標出第一次黃金交叉與死亡交叉
  if (opts.marks && lines.length >= 2) {
    const [a, b] = lines;
    let gold = -1;
    let dead = -1;
    for (let i = 1; i < bars.length; i++) {
      if (a[i - 1] == null || b[i - 1] == null || a[i] == null || b[i] == null) continue;
      const was = a[i - 1]! - b[i - 1]!;
      const now = a[i]! - b[i]!;
      // 只標明顯的交叉：交叉後 3 根內沒有再交叉回去
      const holds = (sign: number) => a.slice(i, i + 3).every((v, k) => v != null && b[i + k] != null && Math.sign(v - b[i + k]!) === sign);
      if (gold < 0 && was <= 0 && now > 0 && holds(1)) gold = i;
      if (dead < 0 && was >= 0 && now < 0 && holds(-1)) dead = i;
    }
    const mark = (i: number, label: string, cls: string) => {
      const y = sy(b[i]!);
      // 文字放在線的下方（上方通常是 K 棒）
      const ty = Math.min(top + ph - 4, y + 30);
      return `<g class="ma-mark ${cls}"><circle cx="${r1(x(i))}" cy="${r1(y)}" r="5"/><text x="${r1(x(i))}" y="${r1(ty)}" text-anchor="middle">${label}</text></g>`;
    };
    if (gold >= 0) s += mark(gold, '黃金交叉', 'is-gold');
    if (dead >= 0) s += mark(dead, '死亡交叉', 'is-dead');
  }
  return `<svg class="learn-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="K 線圖示意">${s}</svg>`;
}

/** K 棒構造圖（標出開高低收、實體、影線）。 */
function anatomy(up: boolean): string {
  const b = up ? { o: 40, c: 80, h: 92, l: 26 } : { o: 80, c: 40, h: 92, l: 26 };
  const sy = (p: number) => 200 - p * 2;
  const x = 70;
  const lab = (p: number, t: string, side: 'r' | 'l' = 'r') => {
    const y = sy(p);
    return side === 'r'
      ? `<line class="lab-line" x1="${x + 26}" x2="${x + 46}" y1="${y}" y2="${y}"/><text class="lab" x="${x + 50}" y="${y + 4}">${t}</text>`
      : `<line class="lab-line" x1="${x - 26}" x2="${x - 46}" y1="${y}" y2="${y}"/><text class="lab" x="${x - 50}" y="${y + 4}" text-anchor="end">${t}</text>`;
  };
  const mid = (a: number, c: number, t: string) => `<text class="lab is-soft" x="${x - 30}" y="${(sy(a) + sy(c)) / 2 + 4}" text-anchor="end">${t}</text>`;
  return `<svg class="learn-svg is-anatomy" viewBox="0 0 230 200" role="img" aria-label="${up ? '紅K' : '綠K'}構造">
    ${candle(x, b, sy, 34)}
    ${lab(b.h, '最高價')}${lab(up ? b.c : b.o, up ? '收盤價' : '開盤價')}${lab(up ? b.o : b.c, up ? '開盤價' : '收盤價')}${lab(b.l, '最低價')}
    ${mid(b.h, Math.max(b.o, b.c), '上影線')}${mid(b.o, b.c, '實體')}${mid(Math.min(b.o, b.c), b.l, '下影線')}
  </svg>`;
}

/** 常見 K 棒的小圖。 */
const SHAPES: { name: string; b: { o: number; h: number; l: number; c: number }; text: string }[] = [
  { name: '大紅K（長紅）', b: { o: 20, c: 85, h: 90, l: 16 }, text: '開低收高、幾乎沒有影線：買方從開盤強到收盤。出現在盤整後常是起漲訊號。' },
  { name: '大綠K（長黑）', b: { o: 85, c: 20, h: 90, l: 16 }, text: '開高收低：賣方一路壓到收盤。出現在高檔常是轉弱訊號。' },
  { name: '十字線', b: { o: 52, c: 53, h: 85, l: 20 }, text: '開盤跟收盤幾乎一樣：多空拉鋸、方向不明。漲一大段或跌一大段後出現，要留意可能轉向。' },
  { name: '長下影線（錘子）', b: { o: 72, c: 80, h: 82, l: 18 }, text: '盤中被殺低，但收盤前被買回來：低檔有人承接。出現在下跌後常被當成止跌訊號。' },
  { name: '長上影線（流星）', b: { o: 28, c: 22, h: 86, l: 20 }, text: '盤中衝高，但賣壓把價格壓回來：上面有人在賣。出現在上漲後要小心。' },
  { name: '小實體（紡錘）', b: { o: 46, c: 56, h: 70, l: 32 }, text: '漲跌都不大：觀望氣氛濃，通常要等之後的 K 棒才看得出方向。' },
];

function shapeSvg(b: { o: number; h: number; l: number; c: number }): string {
  return `<svg class="learn-svg is-mini" viewBox="0 0 60 100" aria-hidden="true">${candle(30, b, (p) => 100 - p, 18)}</svg>`;
}

/** 5 根日 K 合成 1 根週 K 的示意。 */
function weekMerge(): string {
  const days = [
    { o: 50, c: 58, h: 60, l: 47 },
    { o: 58, c: 54, h: 62, l: 52 },
    { o: 54, c: 66, h: 68, l: 53 },
    { o: 66, c: 63, h: 74, l: 61 },
    { o: 63, c: 70, h: 72, l: 60 },
  ];
  const sy = (p: number) => 150 - (p - 40) * 3.6;
  const wk = { o: 50, c: 70, h: 74, l: 47 };
  const names = ['一', '二', '三', '四', '五'];
  return `<svg class="learn-svg is-merge" viewBox="0 0 330 170" role="img" aria-label="五根日K合成一根週K">
    ${days.map((d, i) => candle(24 + i * 36, d, sy, 18) + `<text class="lab is-soft" x="${24 + i * 36}" y="166" text-anchor="middle">週${names[i]}</text>`).join('')}
    <text class="lab" x="208" y="${sy(60) + 4}" text-anchor="middle">→</text>
    ${candle(262, wk, sy, 30)}<text class="lab is-soft" x="262" y="166" text-anchor="middle">這週的週K</text>
    <text class="lab is-tiny" x="282" y="${sy(wk.h) + 4}">週最高</text><text class="lab is-tiny" x="282" y="${sy(wk.l) + 4}">週最低</text>
  </svg>`;
}

/** 走勢線示意（型態、趨勢）。 */
function pathSvg(pts: [number, number][], extra = '', label = ''): string {
  const p = pts.map(([x, y]) => `${x},${y}`).join(' ');
  return `<svg class="learn-svg is-path" viewBox="0 0 200 110" role="img" aria-label="${label}"><polyline class="path" points="${p}"/>${extra}</svg>`;
}

const PATTERNS = [
  {
    name: 'W 底（雙重底）',
    svg: pathSvg([[6, 20], [45, 88], [80, 48], [118, 86], [160, 30], [194, 14]], '<line class="neck" x1="40" x2="196" y1="48" y2="48"/><text class="lab is-tiny" x="56" y="42">頸線</text>', 'W底'),
    text: '跌到同一個價位附近兩次都沒破，第二次反彈突破中間的高點（頸線）時，常被當成止跌回升的訊號。',
  },
  {
    name: 'M 頭（雙重頂）',
    svg: pathSvg([[6, 90], [45, 22], [80, 62], [118, 24], [160, 80], [194, 96]], '<line class="neck" x1="40" x2="196" y1="62" y2="62"/><text class="lab is-tiny" x="56" y="76">頸線</text>', 'M頭'),
    text: 'W 底倒過來：漲到同一個價位兩次都過不去，跌破頸線時常被當成轉弱訊號。',
  },
  {
    name: '頭肩頂',
    svg: pathSvg([[4, 92], [36, 46], [62, 66], [98, 14], [134, 66], [160, 46], [196, 98]], '<line class="neck" x1="50" x2="196" y1="66" y2="66"/><text class="lab is-tiny" x="64" y="80">頸線</text>', '頭肩頂'),
    text: '左肩、頭、右肩三個高點，中間最高。右肩漲不過頭、再跌破頸線，是常見的頭部型態（倒過來就是頭肩底）。',
  },
  {
    name: '上升趨勢',
    svg: pathSvg([[4, 98], [40, 66], [62, 80], [100, 44], [124, 58], [160, 22], [196, 12]], '<line class="sup" x1="4" x2="196" y1="102" y2="44"/><text class="lab is-tiny" x="150" y="70">支撐線</text>', '上升趨勢'),
    text: '高點越來越高、低點也越來越高。把低點連起來就是支撐線，沒跌破之前趨勢就還在。',
  },
  {
    name: '箱型整理',
    svg: pathSvg([[4, 74], [30, 28], [58, 80], [88, 26], [116, 82], [146, 30], [172, 76], [196, 8]], '<line class="neck" x1="0" x2="200" y1="26" y2="26"/><line class="sup" x1="0" x2="200" y1="82" y2="82"/><text class="lab is-tiny" x="4" y="20">壓力</text><text class="lab is-tiny" x="4" y="98">支撐</text>', '箱型整理'),
    text: '價格在一個區間上下來回：上緣是壓力（漲到這裡就有人賣），下緣是支撐（跌到這裡就有人買）。帶量突破上緣常是新一段行情的開始。',
  },
];

const TICKS: [string, string][] = [
  ['未滿 10 元', '0.01'],
  ['10～未滿 50 元', '0.05'],
  ['50～未滿 100 元', '0.1'],
  ['100～未滿 500 元', '0.5'],
  ['500～未滿 1,000 元', '1'],
  ['1,000 元以上', '5'],
];

interface Section {
  id: string;
  title: string;
  html: () => string;
}

const SECTIONS: Section[] = [
  {
    id: 'basic',
    title: '股票是什麼',
    html: () => `
      <p>買股票就是買一家公司的一小部分。公司賺錢，股價可能上漲、也可能發股利給你；公司表現不好，股價就可能下跌。</p>
      <div class="learn-grid">
        <dl class="learn-def"><dt>張與股</dt><dd>1 張 = 1,000 股。股價 600 元的股票，買 1 張要 60 萬；錢不夠可以買<b>零股</b>（1～999 股）。</dd></dl>
        <dl class="learn-def"><dt>交易時間</dt><dd>週一到週五 09:00～13:30。08:30 起可以先掛單，09:00 用<b>集合競價</b>決定開盤價；13:25～13:30 再集合競價一次決定收盤價。</dd></dl>
        <dl class="learn-def"><dt>漲跌停</dt><dd>每天最多漲或跌 <b>10%</b>（以昨天收盤價計算）。漲到頂叫漲停、跌到底叫跌停。</dd></dl>
        <dl class="learn-def"><dt>交割</dt><dd>買進後<b>第二個營業日</b>（T+2）才從銀行帳戶扣款，所以下單前要先確定帳戶裡有錢，否則就是違約交割。</dd></dl>
      </div>
      <h4>股價一次跳多少（升降單位）</h4>
      <div class="learn-table-wrap"><table class="learn-table"><thead><tr><th>股價</th><th>每一檔</th></tr></thead><tbody>
        ${TICKS.map(([a, b]) => `<tr><td>${a}</td><td>${b} 元</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted">ETF 不一樣：未滿 50 元每檔 0.01、50 元以上每檔 0.05。</p>`,
  },
  {
    id: 'kbar',
    title: 'K 棒是什麼',
    html: () => `
      <p>一根 K 棒把<b>一段時間</b>（例如一天）的四個價格畫在一起：<b>開盤價、最高價、最低價、收盤價</b>（簡稱開高低收）。</p>
      <div class="learn-anatomy">
        <figure>${anatomy(true)}<figcaption><b class="up">紅K</b>：收盤 &gt; 開盤（開盤後往上走）</figcaption></figure>
        <figure>${anatomy(false)}<figcaption><b class="down">綠K</b>（也叫黑K）：收盤 &lt; 開盤（開盤後往下走）</figcaption></figure>
      </div>
      <ul class="learn-list">
        <li><b>實體</b>（粗的部分）：開盤到收盤。實體越長，代表這段時間買方（紅）或賣方（綠）越強。</li>
        <li><b>上影線</b>：實體上面的細線，碰到最高價。上影線長＝曾經漲上去，但被賣壓壓回來。</li>
        <li><b>下影線</b>：實體下面的細線，碰到最低價。下影線長＝曾經跌下去，但有買盤把價格撐回來。</li>
      </ul>
      <p class="learn-tip">⚠️ 紅K、綠K 是<b>收盤跟開盤</b>比，不是跟昨天比。開盤跳空大跌、之後一路拉回，會出現「紅K 但今天還是下跌」——下面的實驗室可以試試看。</p>`,
  },
  {
    id: 'lab',
    title: 'K 棒實驗室',
    html: () => `
      <p>拉動下面的價格，看看 K 棒怎麼變、代表什麼意思。昨天收盤固定是 <b>100 元</b>，所以今天只能在 90～110 元之間（漲跌停 10%）。</p>
      <div class="learn-lab">
        <div class="learn-lab-fig"><svg class="learn-svg is-lab" viewBox="0 0 200 240" role="img" aria-label="K 棒實驗室"></svg></div>
        <div class="learn-lab-ctl">
          ${(['o:開盤', 'h:最高', 'l:最低', 'c:收盤'] as const)
            .map((s) => {
              const [k, t] = s.split(':');
              const v = { o: 98, h: 105, l: 96, c: 104 }[k as 'o'];
              return `<label class="learn-range"><span>${t}</span><input type="range" min="90" max="110" step="0.5" value="${v}" data-lab="${k}"><output data-lab-out="${k}">${v}</output></label>`;
            })
            .join('')}
          <div class="learn-presets">
            <button type="button" class="btn btn-sm" data-lab-preset="98,109.5,97.5,109">大紅K</button>
            <button type="button" class="btn btn-sm" data-lab-preset="104,104.5,91,92">大綠K</button>
            <button type="button" class="btn btn-sm" data-lab-preset="100,104,96,100">十字線</button>
            <button type="button" class="btn btn-sm" data-lab-preset="99,101,92,100.5">長下影線</button>
            <button type="button" class="btn btn-sm" data-lab-preset="100,108,99,100.5">長上影線</button>
            <button type="button" class="btn btn-sm" data-lab-preset="93,97,92,96.5">紅K但下跌</button>
          </div>
          <div class="learn-lab-read" aria-live="polite"></div>
        </div>
      </div>`,
  },
  {
    id: 'shapes',
    title: '常見 K 棒怎麼看',
    html: () => `
      <div class="learn-shapes">
        ${SHAPES.map((s) => `<div class="learn-shape">${shapeSvg(s.b)}<div><h4>${s.name}</h4><p>${s.text}</p></div></div>`).join('')}
      </div>
      <p class="learn-tip">一根 K 棒只說明一天發生了什麼。<b>同一根 K 棒出現在不同位置意思不同</b>：長下影線在連跌之後可能是止跌，在高檔可能只是震盪。要搭配前後的走勢與成交量一起看。</p>`,
  },
  {
    id: 'kline',
    title: 'K 線圖怎麼看',
    html: () => `
      <p>把每天的 K 棒照時間排起來，就是 <b>K 線圖</b>。由左到右是時間，越右邊越新；越上面價格越高。下面的長條是每天的<b>成交量</b>。</p>
      <div class="learn-seg" role="group" aria-label="K 線週期">
        <button type="button" class="btn btn-sm is-on" data-kline="1">日K（一根＝一天）</button>
        <button type="button" class="btn btn-sm" data-kline="5">週K（一根＝一週）</button>
      </div>
      <div class="learn-chart"></div>
      <p class="muted">示意走勢，不是真實股票。兩條線是均線：<span class="learn-ma-key"></span>。圓圈標出短均線穿過長均線的地方。</p>
      <h4>週K、月K 怎麼來的</h4>
      <p>週K 就是把這一週 5 根日K 合成一根：<b>開盤＝週一開盤、收盤＝週五收盤、最高＝這週最高、最低＝這週最低</b>。月K 同理。看長期趨勢用週K、月K，看短線進出用日K。</p>
      ${weekMerge()}
      <h4>看 K 線圖的順序</h4>
      <ol class="learn-list">
        <li><b>先看大方向</b>：整體是往右上（上升趨勢）、往右下（下降趨勢），還是橫向（盤整）？</li>
        <li><b>再看位置</b>：現在在相對高檔還是低檔？離前面的高點、低點多遠？</li>
        <li><b>看最近幾根 K 棒</b>：紅多還是綠多？實體大不大？影線長不長？</li>
        <li><b>對照成交量</b>：上漲時量有沒有放大？</li>
        <li><b>對照均線</b>：股價在均線上面還是下面？均線往上還是往下？</li>
      </ol>`,
  },
  {
    id: 'ma',
    title: '均線',
    html: () => `
      <p><b>移動平均線</b>（MA）是最近 N 天收盤價的平均，連起來變成一條線，可以看出<b>這段期間買進的人平均成本</b>與趨勢方向。</p>
      <div class="learn-table-wrap"><table class="learn-table"><thead><tr><th>均線</th><th>俗稱</th><th>代表</th></tr></thead><tbody>
        <tr><td>5 日</td><td>週線</td><td>最近一週，短線</td></tr>
        <tr><td>20 日</td><td>月線</td><td>最近一個月，常用來看短中期趨勢</td></tr>
        <tr><td>60 日</td><td>季線</td><td>最近一季，常被當成多空分界</td></tr>
        <tr><td>240 日</td><td>年線</td><td>最近一年，長期趨勢</td></tr>
      </tbody></table></div>
      <ul class="learn-list">
        <li><b>股價在均線上面、均線往上</b>：這段期間買的人大多賺錢，趨勢偏多。</li>
        <li><b>黃金交叉</b>：短天期均線由下往上穿過長天期均線，常被當成轉強訊號。</li>
        <li><b>死亡交叉</b>：短天期均線由上往下穿過長天期均線，常被當成轉弱訊號。</li>
        <li><b>多頭排列</b>：5 日 &gt; 20 日 &gt; 60 日，而且都往上；反過來就是空頭排列。</li>
      </ul>
      <h4>SMA 與 EMA</h4>
      <ul class="learn-list">
        <li><b>SMA（簡單移動平均）</b>：最近 N 天收盤價直接平均，每一天的權重一樣。上面說的週線、月線、季線通常是這種。</li>
        <li><b>EMA（指數移動平均）</b>：越近的價格權重越大，股價轉彎時 EMA 比 SMA 更快跟著轉，但也比較容易被短暫的波動騙。</li>
        <li><b>模擬盤的 K 線圖用 EMA20、EMA60、EMA120</b>：大約是一個月、一季、半年的趨勢。股價站在三條線上面、三條線由上而下依序是 20 &gt; 60 &gt; 120，就是多頭排列。</li>
      </ul>
      <p class="learn-tip">均線是用過去的價格算的，所以一定<b>比股價慢</b>。盤整的時候均線會一直交叉，訊號很容易失準。</p>`,
  },
  {
    id: 'volume',
    title: '成交量',
    html: () => `
      <p><b>成交量</b>是這段時間成交了多少張。量代表有多少人參與：價格要漲得上去，通常需要有人願意追價買進。</p>
      <div class="learn-table-wrap"><table class="learn-table"><thead><tr><th>狀況</th><th>常見解讀</th></tr></thead><tbody>
        <tr><td>價漲量增</td><td>買盤積極，上漲比較健康</td></tr>
        <tr><td>價漲量縮</td><td>追價的人變少，漲勢可能放緩</td></tr>
        <tr><td>價跌量增</td><td>賣壓大，有人急著出場</td></tr>
        <tr><td>價跌量縮</td><td>賣的人變少，跌勢可能接近尾聲</td></tr>
        <tr><td>高檔爆大量但收長上影線</td><td>可能有人趁高出貨，要小心</td></tr>
      </tbody></table></div>`,
  },
  {
    id: 'pattern',
    title: '趨勢與型態',
    html: () => `
      <p>把很多根 K 棒連起來看，價格常會走出一些常見的形狀（型態）。型態只是<b>機率比較高</b>，不是一定會照著走。</p>
      <div class="learn-patterns">
        ${PATTERNS.map((p) => `<div class="learn-pattern">${p.svg}<h4>${p.name}</h4><p>${p.text}</p></div>`).join('')}
      </div>
      <p class="muted">「個股分析」會自動辨識 20 多種型態，並附上這個型態在台股的歷史勝率。</p>`,
  },
  {
    id: 'indicator',
    title: '技術指標',
    html: () => `
      <div class="learn-grid">
        <dl class="learn-def"><dt>KD</dt><dd>看收盤價在最近 9 天高低區間的哪個位置。K 值 &gt; 80 代表接近區間高點（偏熱）、&lt; 20 接近低點（偏冷）。K 由下往上穿過 D 叫黃金交叉。</dd></dl>
        <dl class="learn-def"><dt>RSI</dt><dd>最近 14 天上漲力道佔多少。&gt; 70 常被說「超買」、&lt; 30「超賣」。強勢股可以在 70 以上待很久。</dd></dl>
        <dl class="learn-def"><dt>MACD</dt><dd>快慢兩條均線的差距，看趨勢的力道。柱狀體由負轉正代表短期力道轉強。</dd></dl>
        <dl class="learn-def"><dt>布林通道</dt><dd>20 日均線上下各加兩個標準差。碰到上軌代表漲得比平常多，通道變窄代表波動變小、常在大行情之前出現。</dd></dl>
      </div>
      <p class="learn-tip">指標都是用價格算出來的，跟 K 線圖看到的是同一件事，只是換個角度。多個指標同時指向同一方向時比較有參考價值。</p>`,
  },
  {
    id: 'fund',
    title: '基本面',
    html: () => `
      <div class="learn-grid">
        <dl class="learn-def"><dt>EPS（每股盈餘）</dt><dd>公司一年賺的錢 ÷ 股數。EPS 5 元＝每一股幫你賺了 5 元。</dd></dl>
        <dl class="learn-def"><dt>本益比（PE）</dt><dd>股價 ÷ EPS。本益比 15 倍＝用公司 15 年的獲利買下它。越低越便宜，但也可能是市場不看好未來。</dd></dl>
        <dl class="learn-def"><dt>殖利率</dt><dd>現金股利 ÷ 股價。股價 100 元、配 5 元，殖利率 5%。</dd></dl>
        <dl class="learn-def"><dt>股價淨值比（PB）</dt><dd>股價 ÷ 每股淨值。小於 1 代表股價比公司帳上的資產還便宜。</dd></dl>
        <dl class="learn-def"><dt>月營收</dt><dd>上市櫃公司每個月 10 日前公布上個月營收。看「年增率」（跟去年同月比）可以排除淡旺季。</dd></dl>
        <dl class="learn-def"><dt>除權息與填息</dt><dd>發股利那天股價會扣掉股利（除息）。之後股價漲回除息前的價格叫<b>填息</b>。</dd></dl>
      </div>`,
  },
  {
    id: 'chips',
    title: '籌碼',
    html: () => `
      <p>籌碼是「股票在誰手上」。大戶或法人持續買進，通常代表有資金在看好這檔股票。</p>
      <div class="learn-grid">
        <dl class="learn-def"><dt>三大法人</dt><dd><b>外資</b>（外國機構）、<b>投信</b>（基金公司）、<b>自營商</b>（券商自己的錢）。每天收盤後公布各自買賣超。</dd></dl>
        <dl class="learn-def"><dt>融資</dt><dd>跟券商借錢買股票（上市股自備 40%）。融資大增常代表散戶追價，籌碼比較亂。</dd></dl>
        <dl class="learn-def"><dt>融券</dt><dd>跟券商借股票先賣（放空），之後買回來還。融券增加代表看空的人變多，但也可能引發軋空。</dd></dl>
        <dl class="learn-def"><dt>千張大戶</dt><dd>持有 1,000 張以上的股東佔比，集保每週公布。持續增加代表籌碼往大戶集中。</dd></dl>
      </div>`,
  },
  {
    id: 'order',
    title: '下單與費用',
    html: () => `
      <div class="learn-grid">
        <dl class="learn-def"><dt>市價單</dt><dd>不指定價格，用當下能成交的價格買賣，成交快但價格不一定漂亮。</dd></dl>
        <dl class="learn-def"><dt>限價單</dt><dd>指定價格：買進最多付這個價，賣出最少賣這個價。價格沒到就不會成交。</dd></dl>
        <dl class="learn-def"><dt>現股當沖</dt><dd>同一天買進又賣出（或先賣後買），不用準備整筆股款，只結算價差。證交稅減半，但風險大。</dd></dl>
        <dl class="learn-def"><dt>停損／停利</dt><dd>事先決定跌到多少就賣（停損）、漲到多少就賣（停利），避免情緒影響判斷。</dd></dl>
      </div>
      <div class="learn-table-wrap"><table class="learn-table"><thead><tr><th>費用</th><th>多少</th><th>什麼時候</th></tr></thead><tbody>
        <tr><td>手續費</td><td>成交金額 × 0.1425%（券商常打折，最低 20 元）</td><td>買、賣都要</td></tr>
        <tr><td>證交稅</td><td>成交金額 × 0.3%（ETF 0.1%、當沖 0.15%）</td><td>只有賣出</td></tr>
      </tbody></table></div>
      <p class="muted">例：100 元買 1 張再用 100 元賣出，手續費約 143 × 2 + 證交稅 300 ≈ 586 元，所以要漲超過 0.6 元左右才開始賺。</p>`,
  },
  {
    id: 'etf',
    title: 'ETF',
    html: () => `
      <p><b>ETF</b> 是一籃子股票包成一檔，像買一張就同時買了很多家公司。例如追蹤台灣前 50 大公司的 ETF。</p>
      <div class="learn-grid">
        <dl class="learn-def"><dt>淨值</dt><dd>ETF 裡面所有股票真正值多少錢（每一單位）。</dd></dl>
        <dl class="learn-def"><dt>折溢價</dt><dd>（市價 − 淨值）÷ 淨值。溢價代表買貴了，熱門 ETF 有時溢價好幾 %。</dd></dl>
        <dl class="learn-def"><dt>被動式／主動式</dt><dd>被動式照指數買；主動式由經理人自己挑股票，每天公布持股。</dd></dl>
        <dl class="learn-def"><dt>內扣費用</dt><dd>管理費、保管費等直接從淨值扣掉，不會另外收，但會吃掉報酬。</dd></dl>
      </div>`,
  },
];


/** K 棒實驗室：讀滑桿、畫 K 棒、寫說明。 */
function updateLab(root: HTMLElement): void {
  const lab = root.querySelector<HTMLElement>('.learn-lab');
  if (!lab) return;
  const inp = (k: string) => lab.querySelector<HTMLInputElement>(`[data-lab="${k}"]`)!;
  const b = { o: +inp('o').value, h: +inp('h').value, l: +inp('l').value, c: +inp('c').value };
  b.h = Math.max(b.h, b.o, b.c);
  b.l = Math.min(b.l, b.o, b.c);
  for (const k of ['o', 'h', 'l', 'c'] as const) {
    inp(k).value = String(b[k]);
    lab.querySelector(`[data-lab-out="${k}"]`)!.textContent = b[k].toFixed(1);
  }
  const sy = (p: number) => 12 + ((110 - p) / 20) * 216;
  const prev = sy(100);
  lab.querySelector('.is-lab')!.innerHTML = `
    <line class="prev" x1="10" x2="190" y1="${prev}" y2="${prev}"/><text class="lab is-tiny" x="190" y="${prev - 4}" text-anchor="end">昨收 100</text>
    ${candle(100, b, sy, 46)}`;
  const range = b.h - b.l || 0.0001;
  const body = Math.abs(b.c - b.o);
  const upper = b.h - Math.max(b.o, b.c);
  const lower = Math.min(b.o, b.c) - b.l;
  const chg = b.c - 100;
  const kind = b.c > b.o ? '<b class="up">紅K</b>' : b.c < b.o ? '<b class="down">綠K</b>' : '<b>平盤K</b>';
  let say: string;
  if (body <= range * 0.1) say = '<b>十字線</b>：開盤跟收盤差不多，多空拉鋸、方向不明。';
  else if (lower >= body * 2 && upper <= body) say = '<b>長下影線</b>：盤中被殺低，收盤前被買回來，低檔有人承接。';
  else if (upper >= body * 2 && lower <= body) say = '<b>長上影線</b>：盤中衝高，但被賣壓壓回來，上面有人在賣。';
  else if (body >= range * 0.7) say = b.c > b.o ? '<b>大紅K</b>：買方從開盤強到收盤。' : '<b>大綠K</b>：賣方從開盤壓到收盤。';
  else say = b.c > b.o ? '一般紅K：收盤比開盤高，買方稍強。' : '一般綠K：收盤比開盤低，賣方稍強。';
  const gap = b.o > 100 ? `開高 ${(b.o - 100).toFixed(1)} 元` : b.o < 100 ? `開低 ${(100 - b.o).toFixed(1)} 元` : '平盤開出';
  const vs =
    (b.c > b.o && chg < 0) || (b.c < b.o && chg > 0)
      ? `<p class="learn-tip">注意：這根是 ${kind}，但跟昨天比是${chg < 0 ? '<b class="down">下跌</b>' : '<b class="up">上漲</b>'}——K 棒顏色看的是收盤跟<b>開盤</b>比。</p>`
      : '';
  lab.querySelector('.learn-lab-read')!.innerHTML = `
    <p>${kind}，${say}</p>
    <ul class="learn-list is-compact">
      <li>${gap}，收盤${chg > 0 ? `<b class="up">漲 ${chg.toFixed(1)} 元（+${chg.toFixed(1)}%）</b>` : chg < 0 ? `<b class="down">跌 ${(-chg).toFixed(1)} 元（${chg.toFixed(1)}%）</b>` : '平盤'}${b.c >= 110 ? '，漲停' : b.c <= 90 ? '，跌停' : ''}</li>
      <li>實體 ${body.toFixed(1)} 元、上影線 ${upper.toFixed(1)} 元、下影線 ${lower.toFixed(1)} 元</li>
    </ul>${vs}`;
}

const DEMO = demoSeries();

function drawKline(root: HTMLElement, n: number): void {
  const el = root.querySelector<HTMLElement>('.learn-chart');
  if (!el) return;
  // 日K 畫後面 100 天（前 20 天給均線暖身）；週K 把 120 天合成 24 根
  el.innerHTML =
    n === 1
      ? klineSvg(DEMO, { mas: [[5, 'is-5'], [20, 'is-20']], marks: true, from: 20 })
      : klineSvg(merge(DEMO, 5), { mas: [[5, 'is-5'], [10, 'is-20']] });
  const key = root.querySelector<HTMLElement>('.learn-ma-key');
  if (key) key.innerHTML = n === 1 ? '<span class="ma-key is-5">5 日均線</span> <span class="ma-key is-20">20 日均線</span>' : '<span class="ma-key is-5">5 週均線</span> <span class="ma-key is-20">10 週均線</span>';
  for (const b of root.querySelectorAll<HTMLElement>('[data-kline]')) b.classList.toggle('is-on', b.dataset.kline === String(n));
}

/** 分類：手機上一次只顯示一類，上方分頁切換。 */
const GROUPS: { id: string; icon: string; title: string; sections: string[] }[] = [
  { id: 'basic', icon: '📖', title: '基本', sections: ['basic', 'order'] },
  { id: 'kbar', icon: '🕯️', title: 'K 棒', sections: ['kbar', 'lab', 'shapes'] },
  { id: 'kline', icon: '📈', title: 'K 線圖', sections: ['kline', 'ma', 'volume'] },
  { id: 'tech', icon: '🔺', title: '型態指標', sections: ['pattern', 'indicator'] },
  { id: 'fund', icon: '🏢', title: '基本面籌碼', sections: ['fund', 'chips'] },
  { id: 'etf', icon: '🧺', title: 'ETF', sections: ['etf'] },
];
const TAB_KEY = 'lplc.learn.tab';

/** 已經畫好的地方（股市入門頁、模擬盤裡各一份）。 */
const rendered = new WeakSet<HTMLElement>();

function showGroup(root: HTMLElement, id: string, scroll: boolean): void {
  const gi = Math.max(0, GROUPS.findIndex((g) => g.id === id));
  const g = GROUPS[gi];
  for (const el of root.querySelectorAll<HTMLElement>('[data-learn-group]')) el.hidden = el.dataset.learnGroup !== g.id;
  const bar = root.querySelector<HTMLElement>('.learn-tabs')!;
  for (const b of bar.querySelectorAll<HTMLElement>('[data-learn-tab]')) {
    const on = b.dataset.learnTab === g.id;
    b.setAttribute('aria-selected', String(on));
    // 手機上分頁列可以左右滑：把選到的分頁捲到中間（只捲分頁列，不動整頁）
    if (on) bar.scrollLeft = b.offsetLeft - (bar.clientWidth - b.offsetWidth) / 2;
  }
  bar.classList.toggle('is-end', bar.scrollLeft + bar.clientWidth >= bar.scrollWidth - 2);
  const prev = GROUPS[gi - 1];
  const next = GROUPS[gi + 1];
  root.querySelector('.learn-pager')!.innerHTML = `
    ${prev ? `<button type="button" class="btn" data-learn-tab="${prev.id}">← ${prev.icon} ${prev.title}</button>` : '<span></span>'}
    ${next ? `<button type="button" class="btn btn-accent" data-learn-tab="${next.id}">下一課：${next.icon} ${next.title} →</button>` : '<span></span>'}`;
  try {
    localStorage.setItem(TAB_KEY, g.id);
  } catch {
    /* 存不了就算了 */
  }
  if (scroll) {
    // 回到這一類的最上面（分頁列下面）
    // 停在分頁列黏住的位置（模擬盤裡上面還有模擬盤的分頁列）
    const bar = root.querySelector<HTMLElement>('.learn-tabs');
    const stick = bar ? parseFloat(getComputedStyle(bar).top) || 8 : 8;
    const top = root.getBoundingClientRect().top + window.scrollY - stick;
    if (window.scrollY > top) window.scrollTo({ top });
  }
}

/** 第一次切到這頁時畫出來（之後不重畫，保留捲動位置與實驗室的值）。 */
export function renderLearnPage(root: HTMLElement, idPrefix = 'learn'): void {
  if (rendered.has(root)) return;
  rendered.add(root);
  // 編號照分類順序（1、2、3…一路往下）
  const order = GROUPS.flatMap((g) => g.sections);
  const byId = new Map(SECTIONS.map((s) => [s.id, { s, n: order.indexOf(s.id) + 1 }]));
  root.innerHTML = `
    <nav class="learn-tabs glass" role="tablist" aria-label="股市入門分類">
      ${GROUPS.map((g) => `<button type="button" role="tab" data-learn-tab="${g.id}" aria-selected="false"><span aria-hidden="true">${g.icon}</span>${g.title}</button>`).join('')}
    </nav>
    <div class="learn-main">
      ${GROUPS.map(
        (g) => `<div class="learn-group" data-learn-group="${g.id}" role="tabpanel" hidden>
          ${
            g.id === 'basic'
              ? `<header class="learn-hero glass">
            <p class="eyebrow">Learn</p>
            <h2>股市入門</h2>
            <p>從「K 棒是什麼」開始，一步一步看懂 K 線圖、均線、成交量、型態、指標、基本面與籌碼。上面的分頁可以直接切換，圖都是示意；可以搭配「個股分析」看真實股票，或到模擬盤實際練習。</p>
          </header>`
              : ''
          }
          ${g.sections
            .map((id) => {
              const { s, n } = byId.get(id)!;
              return `<section class="learn-card glass" aria-labelledby="${idPrefix}-h-${s.id}"><h3 id="${idPrefix}-h-${s.id}"><span class="learn-no">${n}</span>${s.title}</h3>${s.html()}</section>`;
            })
            .join('')}
        </div>`,
      ).join('')}
      <div class="learn-pager"></div>
      <p class="muted learn-foot">以上是常見的看法與經驗法則，不構成投資建議。任何訊號都可能失準，請控制風險。</p>
    </div>`;
  updateLab(root);
  drawKline(root, 1);
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(TAB_KEY);
  } catch {
    /* 沒有就從第一類開始 */
  }
  showGroup(root, saved ?? GROUPS[0].id, false);
  const bar = root.querySelector<HTMLElement>('.learn-tabs')!;
  bar.addEventListener('scroll', () => bar.classList.toggle('is-end', bar.scrollLeft + bar.clientWidth >= bar.scrollWidth - 2), { passive: true });
  root.addEventListener('input', (e) => {
    if ((e.target as HTMLElement).dataset.lab) updateLab(root);
  });
  root.addEventListener('click', (e) => {
    const t = e.target as Element;
    const tab = t.closest<HTMLElement>('[data-learn-tab]');
    if (tab) {
      showGroup(root, tab.dataset.learnTab!, true);
      return;
    }
    const pre = t.closest<HTMLElement>('[data-lab-preset]');
    if (pre) {
      const [o, h, l, c] = pre.dataset.labPreset!.split(',');
      const lab = root.querySelector<HTMLElement>('.learn-lab')!;
      Object.entries({ o, h, l, c }).forEach(([k, v]) => (lab.querySelector<HTMLInputElement>(`[data-lab="${k}"]`)!.value = v));
      updateLab(root);
      return;
    }
    const k = t.closest<HTMLElement>('[data-kline]');
    if (k) drawKline(root, +k.dataset.kline!);
  });
}
