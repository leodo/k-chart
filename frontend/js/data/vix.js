/**
 * 把日线隐波序列对齐到当前 K 线周期：
 * 日线按日期、周线按 ISO 周、日内按相邻交易日线性插值。
 *
 * 原始序列取自期权平值素质的近似 IV，单日可能出现脏报价；这里先做
 * 5 日中位数 + 轻度 EWMA，去掉孤立毛刺，再对齐到图表，避免叠加线乱跳。
 */
function weekKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day + 3);
  const year = d.getFullYear();
  const week = Math.ceil(((d - new Date(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-${week}`;
}

function barDate(bar) {
  if (bar?.time?.length >= 10) return bar.time.slice(0, 10);
  return new Date(bar.ts).toISOString().slice(0, 10);
}

function median(values) {
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 5 日中位数去孤立尖峰 + EWMA 平滑残留抖动。 */
function smooth(points) {
  const raw = points.map(p => Number(p.vix)).filter(Number.isFinite);
  if (raw.length < 2) return points.map(p => ({ ...p, vix: Number(p.vix) }));
  const med = raw.map((_, i) => median(raw.slice(Math.max(0, i - 2), Math.min(raw.length, i + 3))));
  const out = [med[0]];
  for (let i = 1; i < med.length; i++) out.push(out[i - 1] * 0.6 + med[i] * 0.4);
  let k = 0;
  return points.map(p => ({ ...p, vix: Number.isFinite(Number(p.vix)) ? out[k++] : NaN }));
}

/** 日内：把每个交易日最后一个 bar 当作当日隐波锚点，中间用线性插值连成平滑曲线。 */
function alignIntraday(sorted, bars) {
  const byDay = new Map(sorted.map(p => [p.date, Number(p.vix)]));
  const anchors = [];
  let day = '';
  for (let i = 0; i < bars.length; i++) {
    const d = barDate(bars[i]);
    if (d !== day) {
      if (day && byDay.has(day)) anchors.push({ i: i - 1, v: byDay.get(day) });
      day = d;
    }
  }
  if (day && byDay.has(day)) anchors.push({ i: bars.length - 1, v: byDay.get(day) });
  if (!anchors.length) return bars.map(() => NaN);
  if (anchors.length === 1) return bars.map(() => anchors[0].v);

  const out = new Array(bars.length);
  let a = 0;
  for (let i = 0; i < bars.length; i++) {
    while (a < anchors.length - 2 && i > anchors[a + 1].i) a++;
    const left = anchors[a], right = anchors[a + 1];
    if (i <= left.i) { out[i] = left.v; continue; }
    if (i >= right.i) { out[i] = right.v; continue; }
    const t = (i - left.i) / (right.i - left.i);
    out[i] = left.v + (right.v - left.v) * t;
  }
  return out;
}

/** 日内序列按交易时序时间戳对齐；缺档时取最近已公布的一根，不跨到未来。 */
function alignIntradaySeries(series, bars) {
  const sorted = series.slice().sort((a, b) => a.ts - b.ts);
  const times = sorted.map(p => p.ts);
  let ptr = -1;
  return bars.map(bar => {
    while (ptr + 1 < sorted.length && times[ptr + 1] <= bar.ts) ptr += 1;
    return ptr >= 0 ? sorted[ptr].vix : NaN;
  });
}

export function alignVix(series, bars, period, intraday = null) {
  // 日内周期优先用期权日内 K 线实算的序列，能反映盘中涨跌对应的隐波变化。
  if (period !== '1d' && period !== '1w' && Array.isArray(intraday) && intraday.length) {
    return alignIntradaySeries(intraday, bars);
  }
  if (!Array.isArray(series) || !series.length) return bars.map(() => NaN);
  const sorted = smooth(series.slice().sort((a, b) => a.date.localeCompare(b.date)));

  if (period === '1d') {
    const map = new Map(sorted.map(p => [p.date, p.vix]));
    return bars.map(b => map.get(barDate(b)) ?? NaN);
  }

  if (period === '1w') {
    const map = new Map();
    for (const p of sorted) map.set(weekKey(p.date), p.vix);
    return bars.map(b => map.get(weekKey(barDate(b))) ?? NaN);
  }

  return alignIntraday(sorted, bars);
}
