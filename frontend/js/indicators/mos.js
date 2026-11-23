/**
 * MOS：通达信「MACD 背离结构 + 双均线族 + KDJ/均价线高低点」主图指标。
 *
 * 原公式（通达信）与本文件的对应关系：
 *   DIFF/DEA/MACD  —— 注意原公式的 DIFF 乘了 100（与常见 MACD 的缩放不同），这里保持一致；
 *   底部结构        —— MACD 底背离（直接底 / 隔峰底）后的 DIFF 上穿 DEA，画出「●底部结构」；
 *   顶部结构        —— MACD 顶背离（直接顶 / 隔峰顶）后的 DIFF 下穿 DEA，画出「●顶部结构」；
 *   时间            —— 13 根新高/新低标记；
 *   ▲低点 / ▲高点   —— KDJ 低位金叉、收盘价反复站在均价线一侧后的反转；
 *   短期1..5 / 长期1..5 —— EMA(C,N) 逐级再做 EMA(…,3) 的均线族。
 *
 * 通达信函数按原语义实现：REF / BARSLAST / LLV / HHV / HHVBARS / LLVBARS /
 * CROSS / FILTER / COUNT / INTPART / IF / LOG / POW / SMA。
 */
import { ema, tdxSma } from './helpers.js';

/** 均线族的显示定义：key / 标签 / 颜色 / 基础周期参数。 */
export const MOS_LINE_DEFS = [
  { key: 's1', label: '短期1', color: '#e05bd6', family: 'short', level: 1 },
  { key: 's2', label: '短期2', color: '#e05bd6', family: 'short', level: 2 },
  { key: 's3', label: '短期3', color: '#e05bd6', family: 'short', level: 3 },
  { key: 's4', label: '短期4', color: '#e05bd6', family: 'short', level: 4 },
  { key: 's5', label: '短期5', color: '#e05bd6', family: 'short', level: 5 },
  { key: 'l1', label: '长期1', color: '#f0515a', family: 'long', level: 1 },
  { key: 'l2', label: '长期2', color: '#f0515a', family: 'long', level: 2 },
  { key: 'l3', label: '长期3', color: '#f0515a', family: 'long', level: 3 },
  { key: 'l4', label: '长期4', color: '#f0515a', family: 'long', level: 4 },
  { key: 'l5', label: '长期5', color: '#f0515a', family: 'long', level: 5 },
];

const MARKER_COLORS = {
  bottom: '#ff5cd6',   // ●底部结构 MAGENTA
  top: '#2eb87c',      // ●顶部结构 GREEN
  time: '#4c9aff',     // 时间         BLUE
  low: '#f0515a',      // ▲低点        RED
  high: '#2eb87c',     // ▲高点        GREEN
};

/* ---------------- 通达信基础函数（序列版） ---------------- */

/** REF(X,N)：N 可以是数组（逐根取值）；越界返回 NaN。 */
function refAt(arr, i, k) {
  if (!Number.isFinite(k)) return NaN;
  const j = i - Math.round(k);
  return j >= 0 && j < arr.length ? arr[j] : NaN;
}

/** BARSLAST：距最近一次成立多少根；从未成立时回看到第一根（与原公式的 LLV(X,N+1) 口径一致）。 */
function barsLastSeries(flags) {
  const out = new Array(flags.length);
  let last = -1;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) last = i;
    out[i] = last < 0 ? i : i - last;
  }
  return out;
}

/** N 根窗口内的极值索引（并列时取最近的一根，与 HHVBARS/LLVBARS 一致）。 */
function extremeAt(values, n, i, pickMax) {
  const w = Math.max(1, Math.round(n) || 1);
  const from = Math.max(0, i - w + 1);
  let at = -1, best = pickMax ? -Infinity : Infinity;
  for (let j = from; j <= i; j++) {
    const v = values[j];
    if (!Number.isFinite(v)) continue;
    if (at < 0 || (pickMax ? v >= best : v <= best)) { best = v; at = j; }
  }
  return at;
}

/** LLV / HHV。 */
function windowExtreme(values, n, i, pickMax) {
  const at = extremeAt(values, n, i, pickMax);
  return at < 0 ? NaN : values[at];
}

/** CROSS(A,B)：本根 A 上穿 B（前一根 A<=B）。 */
function crossed(a, b, i) {
  if (i <= 0) return false;
  const a0 = a[i - 1], b0 = b[i - 1];
  return Number.isFinite(a[i]) && Number.isFinite(b[i]) && Number.isFinite(a0) && Number.isFinite(b0)
    && a[i] > b[i] && a0 <= b0;
}

/** FILTER(X,N)：X 成立后 N 根内不再输出（N 可以是数字或序列）。 */
function filterSeries(flags, periods) {
  const out = new Uint8Array(flags.length);
  let blockUntil = -1;
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i] || i <= blockUntil) continue;
    out[i] = 1;
    const n = typeof periods === 'number' ? periods : periods[i];
    blockUntil = i + Math.max(0, Math.round(n) || 0);
  }
  return out;
}

/** COUNT(X,N)：最近 N 根内成立的次数。 */
function countTrue(flags, n, i) {
  let c = 0;
  for (let j = Math.max(0, i - n + 1); j <= i; j++) if (flags[j]) c++;
  return c;
}

/** INTPART：向零取整。 */
const intPart = v => (Number.isFinite(v) ? Math.trunc(v) : NaN);

/**
 * 原公式里用来做「有效数字」比较的一组变换：
 *   PD := IF(X>0, INTPART(LOG(X))-1, INTPART(LOG(-X))-1)
 *   MD := INTPART(X / POW(10, PD))
 * 通达信的 LOG 是**以 10 为底**的对数（自然对数是 LN），所以这里必须用 log10：
 * 用 ln 的话 PD 会把 10 的幂次算错，MDIF 全变成 0，背离条件永远不成立（结构信号为 0）。
 */
function digitsOf(x) {
  if (!Number.isFinite(x) || x === 0) return NaN;
  return intPart(Math.log10(Math.abs(x))) - 1;
}
function mantissa(x, digits) {
  if (!Number.isFinite(x) || !Number.isFinite(digits)) return NaN;
  return intPart(x / Math.pow(10, digits));
}

/* ---------------- 主计算 ---------------- */

export function computeMOS(bars, p = {}) {
  const len = bars.length;
  const nShort = Math.max(1, Math.min(200, Math.round(Number(p.shortN) || 10)));
  const nLong = Math.max(1, Math.min(400, Math.round(Number(p.longN) || 45)));
  const showStruct = Number(p.struct ?? 1) !== 0;
  const showTiming = Number(p.timing ?? 1) !== 0;

  const close = bars.map(b => b.close);
  const high = bars.map(b => b.high);
  const low = bars.map(b => b.low);
  const open = bars.map(b => b.open);
  const nz = v => (Number.isFinite(v) ? v : 0);

  /* ---- 均线族：EMA(C,N) 再逐级 EMA(·,3) ---- */
  const chain = (values, base) => {
    const a1 = ema(values, base);
    const a2 = ema(a1, 3), a3 = ema(a2, 3), a4 = ema(a3, 3), a5 = ema(a4, 3);
    return [a1, a2, a3, a4, a5];
  };
  const shortChain = chain(close, nShort);
  const longChain = chain(close, nLong);
  const lines = MOS_LINE_DEFS.map(def => ({
    key: def.key,
    label: def.label,
    color: def.color,
    values: def.family === 'short' ? shortChain[def.level - 1] : longChain[def.level - 1],
  }));

  /* ---- MACD（DIFF 乘 100，原公式口径） ---- */
  const emaFast = ema(close, 12);
  const emaSlow = ema(close, 26);
  const diff = close.map((_, i) => (Number.isFinite(emaFast[i]) && Number.isFinite(emaSlow[i])
    ? 100 * (emaFast[i] - emaSlow[i]) : NaN));
  const dea = ema(diff, 9);
  const macd = diff.map((v, i) => (Number.isFinite(v) && Number.isFinite(dea[i]) ? (v - dea[i]) * 2 : NaN));
  const macdBefore = i => (i > 0 ? macd[i - 1] : NaN);

  const death = new Uint8Array(len);
  const gold = new Uint8Array(len);
  for (let i = 1; i < len; i++) {
    if (crossed(dea, diff, i)) death[i] = 1;
    if (crossed(diff, dea, i)) gold[i] = 1;
  }
  const blDeath = barsLastSeries(death);
  const blGold = barsLastSeries(gold);

  /* ---- 底部：死叉区间的低点 + DIFF 低点 ---- */
  const cl1 = new Array(len).fill(NaN), cl2 = new Array(len).fill(NaN), cl3 = new Array(len).fill(NaN);
  const difl1 = new Array(len).fill(NaN), difl2 = new Array(len).fill(NaN), difl3 = new Array(len).fill(NaN);
  const mdifl2 = new Array(len).fill(NaN), mdifl3 = new Array(len).fill(NaN);
  const mdifb2 = new Array(len).fill(NaN), mdifb3 = new Array(len).fill(NaN);
  const directBottom = new Uint8Array(len), farBottom = new Uint8Array(len);

  for (let i = 0; i < len; i++) {
    const n1 = blDeath[i];
    const w = n1 + 1;
    cl1[i] = windowExtreme(low, w, i, false);
    difl1[i] = windowExtreme(diff, w, i, false);
    const j1 = i - w;                       // REF(·, N1+1)
    if (j1 < 0) continue;
    cl2[i] = cl1[j1];
    difl2[i] = difl1[j1];
    cl3[i] = cl2[j1];                       // CL3 := REF(CL2, N1+1)
    difl3[i] = difl2[j1];
    const pd2 = digitsOf(difl2[i]);
    mdifl2[i] = mantissa(difl2[i], pd2);
    mdifb2[i] = mantissa(diff[i], pd2);
    const pd3 = digitsOf(difl3[i]);
    mdifl3[i] = mantissa(difl3[i], pd3);
    mdifb3[i] = mantissa(diff[i], pd3);
  }

  for (let i = 0; i < len; i++) {
    const macdOk = macd[i] < 0 && macdBefore(i) < 0;
    if (!macdOk) continue;
    // 直接底部结构：(CL1<CL2) AND (MDIFB2>MDIFL2) AND DIFF<0 AND (MACD<0 AND REF(MACD,1)<0)
    directBottom[i] = (cl1[i] < cl2[i] && mdifb2[i] > mdifl2[i] && diff[i] < 0) ? 1 : 0;
    // 隔峰底部结构：(CL1<CL3 AND CL3<CL2) AND (MDIFB3>MDIFL3)
    farBottom[i] = (cl1[i] < cl3[i] && cl3[i] < cl2[i] && mdifb3[i] > mdifl3[i]) ? 1 : 0;
  }

  const bottomRaw = new Uint8Array(len);
  for (let i = 2; i < len; i++) {
    const a = mdifb2[i] > mdifb2[i - 1] && directBottom[i - 2];
    const b = Number.isFinite(mdifb3[i]) && Number.isFinite(mdifb3[i - 2])
      && mdifb3[i] > mdifb3[i - 2] && farBottom[i - 2];
    bottomRaw[i] = (a || b) && crossed(diff, dea, i) ? 1 : 0;
  }
  const bottomSignal = filterSeries(bottomRaw, macd.map(v => (v > 0 ? 1 : 0)));

  /* ---- 顶部：金叉区间的高点 + DIFF 高点 ---- */
  const ch1 = new Array(len).fill(NaN), ch2 = new Array(len).fill(NaN), ch3 = new Array(len).fill(NaN);
  const difh1 = new Array(len).fill(NaN), difh2 = new Array(len).fill(NaN), difh3 = new Array(len).fill(NaN);
  const mdifh2 = new Array(len).fill(NaN), mdifh3 = new Array(len).fill(NaN);
  const mdift2 = new Array(len).fill(NaN), mdift3 = new Array(len).fill(NaN);
  const directTop = new Uint8Array(len), farTop = new Uint8Array(len);

  for (let i = 0; i < len; i++) {
    const m1 = blGold[i];
    const w = m1 + 1;
    ch1[i] = windowExtreme(high, w, i, true);
    difh1[i] = windowExtreme(diff, w, i, true);
    const j1 = i - w;
    if (j1 < 0) continue;
    ch2[i] = ch1[j1];
    difh2[i] = difh1[j1];
    ch3[i] = ch2[j1];
    difh3[i] = difh2[j1];
    const pd2 = digitsOf(difh2[i]);
    mdifh2[i] = mantissa(difh2[i], pd2);
    mdift2[i] = mantissa(diff[i], pd2);
    const pd3 = digitsOf(difh3[i]);
    mdifh3[i] = mantissa(difh3[i], pd3);
    mdift3[i] = mantissa(diff[i], pd3);
  }

  for (let i = 0; i < len; i++) {
    const macdOk = macd[i] > 0 && macdBefore(i) > 0;
    if (!macdOk) continue;
    // 直接顶部结构：(CH1>CH2) AND (MDIFT2<MDIFH2) AND DIFF>0 AND (MACD>0 AND REF(MACD,1)>0)
    directTop[i] = (ch1[i] > ch2[i] && mdift2[i] < mdifh2[i] && diff[i] > 0) ? 1 : 0;
    // 隔峰顶部结构：(CH1>CH3 AND CH3>CH2) AND (MDIFT3<MDIFH3)
    farTop[i] = (ch1[i] > ch3[i] && ch3[i] > ch2[i] && mdift3[i] < mdifh3[i]) ? 1 : 0;
  }

  const topRaw = new Uint8Array(len);
  for (let i = 2; i < len; i++) {
    const a = mdift2[i] < mdift2[i - 1] && directTop[i - 2];
    const b = Number.isFinite(mdift3[i]) && Number.isFinite(mdift3[i - 2])
      && mdift3[i] < mdift3[i - 2] && farTop[i - 2];
    topRaw[i] = (a || b) && crossed(dea, diff, i) ? 1 : 0;
  }
  const topSignal = filterSeries(topRaw, macd.map(v => (v < 0 ? 1 : 0)));

  /* ---- 时间：13 根新高 / 新低 ---- */
  const w1Raw = new Uint8Array(len), w2Raw = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    w1Raw[i] = extremeAt(high, 13, i, true) === i ? 1 : 0;
    w2Raw[i] = extremeAt(low, 13, i, false) === i ? 1 : 0;
  }
  const w1 = filterSeries(w1Raw, 13);
  const w2 = filterSeries(w2Raw, 13);

  /* ---- KDJ 低位金叉（▲低点） ---- */
  const rsv = close.map((c, i) => {
    const lo = windowExtreme(low, 9, i, false);
    const hi = windowExtreme(high, 9, i, true);
    return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? (c - lo) / (hi - lo) * 100 : 0;
  });
  const midLine = tdxSma(rsv, 3, 1);       // SMA(短线,3,1)
  const kCross = new Uint8Array(len);
  for (let i = 1; i < len; i++) if (crossed(midLine, rsv, i)) kCross[i] = 1;
  const blKCross = barsLastSeries(kCross);
  const lowPoint = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    lowPoint[i] = blKCross[i] >= 3 && crossed(rsv, midLine, i) && midLine[i] < 30 ? 1 : 0;
  }

  /* ---- 均价线 TYX3：连站 5 根后反向拉回（▲高点） ---- */
  const tyx = bars.map(b => (b.close + b.low + b.open + b.high) / 4);
  const hhv30 = tyx.map((_, i) => windowExtreme(tyx, 30, i, true));
  // TYX3 := MA(REF(HHV(TYX,30),1),3) = (HHV[i-3] + HHV[i-2] + HHV[i-1]) / 3
  // 注意不能直接对「首根为 NaN」的数组用通用 sma()：它按索引回减会减到 NaN，之后整条都失效。
  const tyx3 = new Array(len).fill(NaN);
  for (let i = 3; i < len; i++) {
    const a = hhv30[i - 3], b = hhv30[i - 2], c = hhv30[i - 1];
    if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c)) tyx3[i] = (a + b + c) / 3;
  }
  const belowTyx = new Uint8Array(len), aboveTyx = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    if (!Number.isFinite(tyx3[i])) continue;
    belowTyx[i] = close[i] < tyx3[i] ? 1 : 0;
    aboveTyx[i] = close[i] > tyx3[i] ? 1 : 0;
  }
  const highPoint = new Uint8Array(len);
  for (let i = 1; i < len; i++) {
    highPoint[i] = Number.isFinite(tyx3[i])
      && countTrue(aboveTyx, 5, i - 1) === 5
      && close[i] < tyx3[i] && close[i] < open[i] ? 1 : 0;
  }
  // 原公式的 B01 只赋值不画，这里保留计算以便对照，不产出标记。

  /* ---- 标记 ----
   * 只给「锚点价格 + 上下方向」，具体画在离 K 线多少像素由渲染层决定：
   * 原公式用 L*0.994 / H*1.02 这种按比例偏移，价格高或视野窄时标签会飘到很远
   * （图上时间/低点离 K 线几百像素那种），改成固定像素偏移后就始终贴着对应 K 线。
   */
  const markers = [];
  const seen = new Set();
  const push = (i, price, text, color, side) => {
    if (!Number.isFinite(price)) return;
    const key = `${i}|${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    markers.push({ i, price, text, color, side });
  };
  for (let i = 0; i < len; i++) {
    if (showStruct) {
      if (bottomSignal[i]) push(i, nz(low[i]), '●底部结构', MARKER_COLORS.bottom, 'below');
      if (topSignal[i]) push(i, nz(high[i]), '●顶部结构', MARKER_COLORS.top, 'above');
    }
    if (showTiming) {
      // 原公式把「时间」一律画在 H*1.01；这里按性质分边：新高标上方、新低标下方。
      if (w1[i]) push(i, nz(high[i]), '时间', MARKER_COLORS.time, 'above');
      if (w2[i]) push(i, nz(low[i]), '时间', MARKER_COLORS.time, 'below');
      if (lowPoint[i]) push(i, nz(low[i]), '▲低点', MARKER_COLORS.low, 'below');
      if (highPoint[i]) push(i, nz(high[i]), '▲高点', MARKER_COLORS.high, 'above');
    }
  }

  return {
    lines,
    markers,
    signalCount: markers.length,
    // 便于排查/图例：最近一次结构信号
    lastSignal: markers.length ? markers[markers.length - 1] : null,
  };
}
