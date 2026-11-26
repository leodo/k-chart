/**
 * 神奇九转（TD Sequential 的 9 / 13 计数，主图叠加）。
 *
 * 口径：
 * - 上涨九转（卖）：连续 N 根收盘价 > N 根前收盘价，数字 1..9 画在 K 线上方；
 * - 下跌九转（买）：连续 N 根收盘价 < N 根前收盘价，数字 1..9 画在 K 线下方；
 * - 数满 9 后进入 13 计数：按 C 与两根前收盘价（REF(C,2)）比较继续数到 13。
 *
 * 只使用截至当前 bar 的数据，不引用未来数据；这是形态计数，不是买卖建议。
 */
export const NINE_LINE_DEFS = [
  { key: 'sell', label: '上涨九转（红）', color: '#f0515a' },
  { key: 'buy', label: '下跌九转（绿）', color: '#2eb87c' },
];

const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};

/**
 * 返回 { lines: [], nineMarkers, stats }。
 * lines 留空：九转只画数字标记，不画线；样式面板的颜色来自 REGISTRY.nine.lines。
 */
export function computeNine(bars, p = {}) {
  const len = bars.length;
  const n = clampInt(p.setup ?? p.n, 1, 20, 4);
  const show13 = Number(p.count13 ?? 1) !== 0;
  const showAll = Number(p.showAll ?? 1) !== 0;
  const close = bars.map(b => b.close);
  const markers = [];
  const stats = { buy9: 0, sell9: 0, buy13: 0, sell13: 0 };

  // dir: 1=上涨九转(卖) / -1=下跌九转(买) / 0=未成立
  let dir = 0;
  let count = 0;
  let stage = 'setup';
  let countdown = 0;

  const push = (i, text, direction, strong) => {
    const bar = bars[i];
    if (!bar) return;
    markers.push({
      i,
      price: direction > 0 ? bar.high : bar.low,
      text,
      side: direction > 0 ? 'above' : 'below',
      key: direction > 0 ? 'sell' : 'buy',
      color: direction > 0 ? '#f0515a' : '#2eb87c',
      dir: direction,
      strong,
    });
  };

  for (let i = n; i < len; i++) {
    const diff = close[i] - close[i - n];
    const cand = diff > 0 ? 1 : diff < 0 ? -1 : 0;

    if (stage === 'countdown') {
      // 反向的 4 周期比较成立 => 旧结构作废，立即从新方向第 1 根开始数。
      if (cand && cand !== dir) {
        stage = 'setup';
        dir = cand;
        count = 1;
        countdown = 0;
        if (showAll) push(i, '1', dir, false);
        continue;
      }
      if (show13 && i >= 2) {
        const ok = dir > 0 ? close[i] > close[i - 2] : close[i] < close[i - 2];
        countdown = ok ? countdown + 1 : 0;
        if (countdown >= 13) {
          push(i, '13', dir, true);
          if (dir > 0) stats.sell13++; else stats.buy13++;
          stage = 'setup';
          dir = 0;
          count = 0;
          countdown = 0;
        }
      }
      continue;
    }

    // setup：条件中断或方向改变都重新从 1 开始，不跨中断续数。
    if (!cand || cand !== dir) {
      dir = cand;
      count = cand ? 1 : 0;
    } else {
      count++;
    }
    if (!count) continue;

    if (count < 9) {
      if (showAll) push(i, String(count), dir, false);
      continue;
    }
    if (count === 9) {
      push(i, '9', dir, true);
      if (dir > 0) stats.sell9++; else stats.buy9++;
      if (show13) {
        stage = 'countdown';
        countdown = 0;
      } else {
        dir = 0;
        count = 0;
      }
    } else {
      // 同一段结构只标一次 9；要等反向结构出现并重新数满 9 才再提示。
      count = 9;
    }
  }

  return { lines: [], nineMarkers: markers, stats };
}
