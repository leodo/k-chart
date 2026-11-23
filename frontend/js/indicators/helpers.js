/** 指标计算的纯函数工具：全部返回与 bars 等长的数组，前段用 NaN 表示无效。 */

export function sma(values, period) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { sum = 0; continue; }
    sum += v;
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 通达信/文华式 SMA(X,N,M)：Y=(M*X+(N-M)*Y')/N；M=1 即 Wilder 平滑。 */
export function tdxSma(values, period, weight) {
  const out = new Array(values.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    prev = Number.isNaN(prev) ? v : (weight * v + (period - weight) * prev) / period;
    out[i] = prev;
  }
  return out;
}

export function wilder(values, period) { return tdxSma(values, period, 1); }

export function ema(values, period) {
  const out = new Array(values.length).fill(NaN);
  const k = 2 / (period + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    prev = Number.isNaN(prev) ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** 滚动标准差（总体标准差，布林带口径）。 */
export function stddev(values, period) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { sum = 0; sumSq = 0; continue; }
    sum += v;
    sumSq += v * v;
    if (i >= period) {
      const old = values[i - period];
      sum -= old;
      sumSq -= old * old;
    }
    if (i >= period - 1) {
      const mean = sum / period;
      out[i] = Math.sqrt(Math.max(0, sumSq / period - mean * mean));
    }
  }
  return out;
}

export function highest(values, period, end) {
  let v = -Infinity;
  const from = Math.max(0, end - period + 1);
  for (let i = from; i <= end; i++) {
    const x = values[i];
    if (Number.isFinite(x) && x > v) v = x;
  }
  return v;
}

export function lowest(values, period, end) {
  let v = Infinity;
  const from = Math.max(0, end - period + 1);
  for (let i = from; i <= end; i++) {
    const x = values[i];
    if (Number.isFinite(x) && x < v) v = x;
  }
  return v;
}

export function trueRange(bars, i) {
  const b = bars[i];
  if (i === 0) return b.high - b.low;
  const prevClose = bars[i - 1].close;
  return Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
}

export function closes(bars) { return bars.map(b => b.close); }

export function mergeLineSets(...sets) {
  const lines = [];
  for (const set of sets) if (set) lines.push(...set);
  return lines;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Wilder ATR：所有阈值以 ATR 归一，跨品种/跨波动率自适应。 */
export function atr(bars, period = 14) {
  const len = bars.length;
  const out = new Array(len).fill(NaN);
  if (!len || period < 1) return out;
  let prev = NaN;
  for (let i = 0; i < len; i++) {
    if (i < period - 1) continue;
    if (Number.isNaN(prev)) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += trueRange(bars, j);
      prev = s / period;
    } else {
      prev = (prev * (period - 1) + trueRange(bars, i)) / period;
    }
    out[i] = prev;
  }
  return out;
}

/**
 * ZigZag 转折点：以反转阈值 thr（= zzMult × ATR）确认摆动高低点。
 * thr 与输入等长；首点用于初始化方向，不作锚。返回 [{i, kind:'H'|'L', v}]。
 */
export function zigzag(highs, lows, thr) {
  const n = highs.length;
  const pivots = [];
  if (n < 3) return pivots;
  let trend = 0;                      // 1 找高点 / -1 找低点
  let extI = 0, extV = highs[0];
  const at = i => Number.isFinite(thr[i]) ? thr[i]
    : (i > 0 && Number.isFinite(thr[i - 1]) ? thr[i - 1] : 0);
  for (let i = 1; i < n; i++) {
    const th = at(i);
    if (trend >= 0) {
      if (highs[i] > extV) { extV = highs[i]; extI = i; }
      if (lows[i] < extV - th && i > extI) {
        pivots.push({ i: extI, kind: 'H', v: extV });
        trend = -1; extV = lows[i]; extI = i;
      }
    } else {
      if (lows[i] < extV) { extV = lows[i]; extI = i; }
      if (highs[i] > extV + th && i > extI) {
        pivots.push({ i: extI, kind: 'L', v: extV });
        trend = 1; extV = highs[i]; extI = i;
      }
    }
  }
  return pivots;
}

/** 把命中的支点索引按最大间隔 gap 分簇：同一峰/谷的相邻支点只算一个触点。 */
function groupIndices(idxs, gap) {
  if (!idxs.length) return [];
  const s = idxs.slice().sort((a, b) => a - b);
  const groups = [[s[0]]];
  for (let i = 1; i < s.length; i++) {
    if (s[i] - s[i - 1] > gap) groups.push([s[i]]);
    else groups[groups.length - 1].push(s[i]);
  }
  return groups;
}

/**
 * 锚点法拟合轨道：以每个真实支点做锚，统计容差内穿过的支点簇。
 * 轨道严格经过真实高低点（用户要求"用绝对点，不要回归"）。
 * 返回按截距去重后的 Top-K 候选。
 */
function fitRails(points, slope, tol, gap, topK = 4) {
  const cands = [];
  for (const anchor of points) {
    const b = anchor.v - slope * anchor.i;
    const hits = [];
    let weight = 0;
    for (const pt of points) {
      if (Math.abs((pt.v - slope * pt.i) - b) <= tol) {
        hits.push(pt.i);
        weight += pt.w;
      }
    }
    if (hits.length < 2) continue;
    const groups = groupIndices(hits, gap);
    const span = hits[hits.length - 1] - hits[0] + 1;
    const score = weight * 1000 + groups.length * 20 + span * 0.1;
    cands.push({ b, hits, groups, span, weight, score, first: hits[0], last: hits[hits.length - 1] });
  }
  cands.sort((a, b) => a.b - b.b);
  const uniq = [];
  for (const c of cands) {
    const last = uniq[uniq.length - 1];
    if (!last || c.b - last.b > tol * 0.8) uniq.push(c);
    else if (c.score > last.score) uniq[uniq.length - 1] = c;
  }
  uniq.sort((a, b) => b.score - a.score);
  return uniq.slice(0, topK);
}

/** 线值数组比 K 线多留一段，用于向「未来方向」外推（右侧留白区可见）。 */
export const CH_EXTEND_MAX = 60;

/** 空的多支撑结果骨架。 */
function emptySupportResult(len, extra = CH_EXTEND_MAX) {
  const n = len + extra;
  return {
    mode: 'none', prim: null,
    upper: new Array(n).fill(NaN), lower: new Array(n).fill(NaN),
    mid: new Array(n).fill(NaN), single: new Array(n).fill(NaN),
    touchPoints: { upper: [], lower: [], single: [] }, metrics: null,
    supports: [],
  };
}

/** 候选线在绝对索引 i 上的价格；通道取主轨（prim 指定的那一条边）。 */
function lineValueAt(r, i) {
  if (r.mode === 'channel') {
    const b = r.prim === 'lower' ? r.best.dn.b : r.best.up.b;
    return r.best.slope * (i - r.start) + b;
  }
  return r.singleSlope * (i - r.start) + r.singleB;
}

/** 一条线（或一组通道）的全部触点。 */
export function allTouchPoints(r) {
  return [].concat(r.touchPoints?.upper || [], r.touchPoints?.lower || [], r.touchPoints?.single || []);
}

/**
 * 绘制区间 = 「触点实际覆盖的区间」两端各外推 extBefore / extAfter 根。
 *
 * 线长只由触点决定：两个触点之间/之外没有证据的地方不画。
 * 以前大级别通道是「射线」，无论最后一个触点在哪都会一路画到最新 K 线右侧，
 * 于是出现图 2 那种横穿整个画面、跟当前行情已经无关的长线；现在统一收口。
 * stopAtBreak=true 时，若价格在真实 K 线区已有效突破轨道，线在突破处截断。
 */
function drawRange(r, cap, bars, stopAtBreak = true) {
  const pts = allTouchPoints(r);
  const firstTouch = pts.length ? Math.min(...pts.map(x => x.i)) : r.start;
  const lastTouch = pts.length ? Math.max(...pts.map(x => x.i)) : r.start + r.m - 1;
  let from = Math.max(0, Math.min(cap, firstTouch - (r.extBefore || 0)));
  let to = Math.max(from, Math.min(cap, lastTouch + (r.extAfter || 0)));
  if (bars && stopAtBreak) {
    const isRes = r.prim !== 'lower';
    const atr = r.meanATR || 1;
    // 大级别轨道允许被影线轻刺，阈值放宽到 1 个 ATR；短线用 0.35 ATR。
    const breakThr = (r.major ? 1.0 : 0.35) * atr;
    for (let i = Math.max(from, lastTouch + 1); i <= Math.min(to, bars.length - 1); i++) {
      const over = isRes ? bars[i].close - lineValueAt(r, i) : lineValueAt(r, i) - bars[i].close;
      if (over > breakThr) { to = Math.min(to, i + 2); break; }
    }
  }
  return { from, to, firstTouch, lastTouch };
}

/**
 * 轨道有效性：压力线不允许 K 线明显站到上方，支撑线不允许明显跌破下方。
 * 允许极少量（2%）影线毛刺；出现两根以上收盘有效穿越即判为「画错的线」。
 */
function railValid(bars, lo, hi, at, isRes, tol, atr) {
  const span = hi - lo;
  const wickAllow = Math.max(2, Math.round(span * 0.04));
  const closeAllow = Math.max(1, Math.round(span * 0.02));
  let wick = 0, closeBreak = 0;
  for (let i = lo; i <= hi; i++) {
    const v = at(i);
    const overWick = isRes ? bars[i].high - v : v - bars[i].low;
    const overClose = isRes ? bars[i].close - v : v - bars[i].close;
    // 允许少量影线毛刺（趋势线本来就会被影线轻刺），但明确的长影线/收盘突破判失效。
    if (overWick > tol) {
      wick++;
      if (overWick > 1.3 * atr || wick > wickAllow) return false;
    }
    if (overClose > 0.25 * atr) {
      closeBreak++;
      if (overClose > 1.0 * atr || closeBreak > closeAllow) return false;
    }
  }
  return true;
}

/** 候选线整体校验：绘制区间内的所有真实 K 线都不能穿越对应边轨。 */
function candidateValid(r, bars, cap) {
  const { from, to } = drawRange(r, cap, bars, false);
  const lo = Math.max(0, from), hi = Math.min(bars.length - 1, to);
  if (hi - lo < 4) return false;
  const tol = r.tol || 0.45 * (r.meanATR || 1);
  const atr = r.meanATR || 1;
  if (r.mode === 'channel') {
    const upAt = i => r.best.slope * (i - r.start) + r.best.up.b;
    const dnAt = i => r.best.slope * (i - r.start) + r.best.dn.b;
    return railValid(bars, lo, hi, upAt, true, tol, atr)
      && railValid(bars, lo, hi, dnAt, false, tol, atr);
  }
  const isRes = r.prim !== 'lower';
  if (!railValid(bars, lo, hi, i => lineValueAt(r, i), isRes, tol, atr)) return false;

  // 悬空线校验：两个触点之间若价格长期远在轨道另一侧，说明这条线只是
  // 碰巧经过两个点（例如下跌行情里连出的「上升压力线」），属于画错的线。
  const tp = [].concat(r.touchPoints.upper || [], r.touchPoints.lower || [], r.touchPoints.single || []);
  if (tp.length >= 2) {
    const a = Math.max(0, Math.min(...tp.map(x => x.i)));
    const b = Math.min(bars.length - 1, Math.max(...tp.map(x => x.i)));
    let sum = 0, n = 0;
    for (let i = a; i <= b; i++) {
      const v = lineValueAt(r, i);
      const d = isRes ? v - bars[i].high : bars[i].low - v;
      if (d > 0) { sum += d; n++; }
    }
    if (n > 3 && sum / n > 2.2 * atr) return false;
  }
  return true;
}

/**
 * 对 [start, start+m) 做一次独立拟合（ATR 归一 + ZigZag 锚点 + 绝对点锚点法）。
 * 返回一个纯数据候选，供 autoChannel / autoSupports 复用，不写任何输出数组。
 * 候选的 slope/b 均为「相对窗口起点」的绝对点直线：price(i) = slope*(i-start)+b。
 */
function fitWindow(bars, atrAll, p, start, m, forceDir) {
  const len = bars.length;
  if (start < 0 || start + m > len || m < 30) return null;
  const atrN = clamp(Math.round(p.atrN || 14), 2, 100);
  const zzMult = clamp(Number(p.zz) > 0 ? Number(p.zz) : 2, 0.5, 10);
  const tolATR = clamp(Number(p.tol) > 0 ? Number(p.tol) : 0.45, 0.1, 2);
  const minTouch = clamp(Math.round(p.minTouch || 3), 2, 12);
  const extAfter = clamp(Math.round(Number(p.extend) || 0), 0, CH_EXTEND_MAX);
  const extBefore = Math.min(8, Math.round(extAfter / 2));
  {
    const w = bars.slice(start, start + m);
    const winAtr = atrAll.slice(start, start + m);
    const av = winAtr.filter(Number.isFinite);
    if (av.length < m * 0.4) return null;
    const meanATR = av.reduce((a, b) => a + b, 0) / av.length || 1;
    const tol = tolATR * meanATR;

    // 1) ZigZag 锚点（首点不作锚）
    const thr = winAtr.map(a => zzMult * (Number.isFinite(a) ? a : meanATR));
    const highs = w.map(b => b.high), lows = w.map(b => b.low);
    const piv = zigzag(highs, lows, thr).slice(1);
    const ph = piv.filter(x => x.kind === 'H').map(x => ({ i: x.i, v: x.v }));
    const pl = piv.filter(x => x.kind === 'L').map(x => ({ i: x.i, v: x.v }));
    if (ph.length + pl.length < 3) return null;

    const maxH = ph.length ? Math.max(...ph.map(x => x.v)) : Math.max(...highs);
    const minL = pl.length ? Math.min(...pl.map(x => x.v)) : Math.min(...lows);
    const spanP = Math.max(maxH - minL, meanATR);
    for (const x of ph) x.w = 0.3 + 0.7 * Math.pow(clamp((x.v - minL) / spanP, 0, 1), 3);
    for (const x of pl) x.w = 0.3 + 0.7 * Math.pow(clamp((maxH - x.v) / spanP, 0, 1), 3);

    // 2) 候选斜率：ATR 限幅网格 + 同侧支点连线
    const maxSlope = 0.2 * meanATR;
    const sStep = Math.max(1e-4, meanATR * 0.005);
    const freq = new Map();
    for (let k = -12; k <= 12; k++) {
      const s = Math.round((k * maxSlope / 12) / sStep) * sStep;
      freq.set(s, (freq.get(s) || 0) + 1);
    }
    const addSlopes = arr => {
      for (let a = 0; a < arr.length; a++) {
        for (let b = a + 1; b < arr.length; b++) {
          const di = arr[b].i - arr[a].i;
          if (di < 4) continue;
          const sv = Math.round(((arr[b].v - arr[a].v) / di) / sStep) * sStep;
          if (Math.abs(sv) <= maxSlope) freq.set(sv, (freq.get(sv) || 0) + 1);
        }
      }
    };
    addSlopes(ph); addSlopes(pl);
    const slopes = [...freq.entries()]
      .filter(([sv]) => Math.abs(sv) <= maxSlope)
      .sort((a, b) => b[1] - a[1]).slice(0, 600).map(e => e[0]);

    const gap = 6;
    const minWidth = 2 * meanATR, maxWidth = 6 * meanATR;

    // 3) 通道搜索
    let best = null;
    if (ph.length >= 2 && pl.length >= 2) {
      for (const sv of slopes) {
        const ups = fitRails(ph, sv, tol, gap, 4);
        const dns = fitRails(pl, sv, tol, gap, 4);
        for (const up of ups) {
          for (const dn of dns) {
            if (up.groups.length < 1 || dn.groups.length < 1) continue;
            const clusters = up.groups.length + dn.groups.length;
            if (clusters < minTouch) continue;
            const width = up.b - dn.b;
            if (width < minWidth || width > maxWidth) continue;
            if (Math.min(up.last, dn.last) - Math.max(up.first, dn.first) < -gap * 2) continue;
            let inside = 0;
            for (let i = 0; i < m; i++) {
              if (highs[i] <= sv * i + up.b + tol && lows[i] >= sv * i + dn.b - tol) inside++;
            }
            const containment = inside / m;
            const all = up.hits.concat(dn.hits);
            const spanBars = Math.max(...all) - Math.min(...all) + 1;
            const score = 200 * containment + 25 * (up.groups.length + dn.groups.length)
              + 35 * Math.min(up.groups.length, dn.groups.length)
              + 0.1 * Math.min(spanBars, 300) - 8 * Math.max(0, width / meanATR - 5);
            if (!best || score > best.score) {
              best = { slope: sv, up, dn, clusters, containment, spanBars, width, score };
            }
          }
        }
      }
    }

    const channelOK = best && best.containment >= 0.5 && best.spanBars >= Math.min(30, m * 0.12)
      && best.up.groups.length >= 2 && best.dn.groups.length >= 2 && best.width <= maxWidth;

    // 触点标记工具（绝对索引）
    const priceAt = new Map();
    for (const x of ph) priceAt.set(x.i, x.v);
    for (const x of pl) if (!priceAt.has(x.i)) priceAt.set(x.i, x.v);
    const pickPeaks = (hits, favorHigh) => groupIndices(hits, gap).map(grp => {
      let bi = grp[0];
      for (const idx of grp) {
        const pv = priceAt.get(idx) ?? 0, bv = priceAt.get(bi) ?? 0;
        if (favorHigh ? pv > bv : pv < bv) bi = idx;
      }
      return { i: start + bi, v: priceAt.get(bi) };
    });

    const result = { start, m, meanATR, tol, best, channelOK, pickPeaks, ph, pl, w, slopes, gap };

    // 统一排序分：触点簇 + 显著性 + 覆盖比例(归一化，避免长窗口单线因绝对跨度虚高)。
    const unified = (r, winLen) => r.groups.length * 12 + r.weight * 2 + 20 * (r.span / winLen);
    const unifiedChan = (a, b, winLen) =>
      (unified(a, winLen) + unified(b, winLen)) / 2 + 300 * (best.containment - 0.5);
    const cap = len + CH_EXTEND_MAX - 1;
    if (channelOK) {
      result.mode = 'channel';
      result.prim = best.slope < 0 ? 'upper' : 'lower';
      result.score = best.score;
      // 双侧取均值与单线同尺度比较；包含率低于 0.5 为负，作为"是否真是通道"的决定项
      result.rank = unifiedChan(best.up, best.dn, m);
      result.touchPoints = { upper: pickPeaks(best.up.hits, true), lower: pickPeaks(best.dn.hits, false) };
      result.metrics = {
        containment: best.containment, widthATR: best.width / meanATR,
        span: best.spanBars, nUp: best.up.groups.length, nDn: best.dn.groups.length,
        slopeATR: best.slope / meanATR, score: best.score, window: m,
      };
      result.extAfter = extAfter;
      result.extBefore = extBefore;
      result.dir = 0;
      result.variants = [];
      // 上下轨在绘制区间内被 K 线穿越 => 这是一条已经被突破的失效通道，不画。
      if (candidateValid(result, bars, cap)) return result;
    }

    // 单线：默认下跌取上边沿、上涨取下边沿。
    // forceDir 由 autoSupports 显式指定（side=3 时分别拟合支撑/压力两个方向）。
    const rawDir = (w[m - 1].close - w[0].close) / m;
    const side = Number(p.side) || 0;
    const forced = forceDir != null ? forceDir : side === 1 ? 1 : side === 2 ? -1 : 0;
    const dir = forced || rawDir;
    const sidePts = dir < 0 ? ph : pl;
    if (sidePts.length < 2) return null;

    // 按斜率分桶保留多个候选：同一个支点允许被多条不同斜率的线穿过，
    // 不再只留全局最优的一条，否则会少画很多压力线/支撑线。
    // 但每条候选都必须通过「K 线不穿越」校验，避免画出错线。
    const makeSingle = cand => ({
      ...result,
      mode: 'single', prim: dir < 0 ? 'upper' : 'lower',
      singleB: cand.r.b, singleSlope: cand.slope,
      score: cand.r.score, rank: unified(cand.r, m),
      touchPoints: { single: pickPeaks(cand.r.hits, dir >= 0 ? false : true) },
      metrics: {
        containment: NaN, widthATR: 0, span: cand.r.span,
        nUp: dir < 0 ? cand.r.groups.length : 0,
        nDn: dir >= 0 ? cand.r.groups.length : 0,
        slopeATR: cand.slope / meanATR, score: cand.r.score, window: m,
        fallback: best ? '通道质量未达标' : '无双侧支点',
      },
      extAfter, extBefore, dir: dir < 0 ? -1 : 1, variants: [],
    });
    let singleBest = null;
    const buckets = new Map();
    const bucketStep = Math.max(1e-6, 0.025 * meanATR);
    for (const sv of slopes) {
      for (const r of fitRails(sidePts, sv, tol, gap, 3)) {
        if (r.groups.length < 2) continue;
        const cand = { slope: sv, r };
        if (!candidateValid(makeSingle(cand), bars, cap)) continue;
        if (!singleBest || r.score > singleBest.r.score) singleBest = cand;
        const bk = Math.round(sv / bucketStep);
        const prev = buckets.get(bk);
        if (!prev || r.score > prev.r.score) buckets.set(bk, cand);
      }
    }
    if (!singleBest) return null;

    const main = makeSingle(singleBest);
    const bestBucket = Math.round(singleBest.slope / bucketStep);
    main.variants = [...buckets.entries()]
      .filter(([bk]) => bk !== bestBucket)
      .map(([, cand]) => cand)
      .sort((a, b) => b.r.score - a.r.score)
      .slice(0, 3)
      .map(makeSingle);
    return main;
  }
}

/**
 * 把单个候选写进线值数组。
 * 绘制区间以「触点跨度」为基准，而不是整个拟合窗口 —— 这样线不会在历史方向画很长；
 * 两端略作外推：向前 extBefore 根、向后 extAfter 根（可越过最新 K 线，
 * 在右侧留白区看到"未来离压力/支撑线还有多远"）。
 */
function paintCandidate(out, r, prefix = '', bars = null) {
  const key = k => `${prefix}${k}`;
  const cap = out[key('single')].length - 1;
  const { from, to } = drawRange(r, cap, bars);
  if (r.mode === 'channel') {
    const { slope, up, dn } = r.best;
    for (let i = from; i <= to; i++) {
      const rel = i - r.start;
      out[key('upper')][i] = slope * rel + up.b;
      out[key('lower')][i] = slope * rel + dn.b;
      out[key('mid')][i] = (out[key('upper')][i] + out[key('lower')][i]) / 2;
    }
  } else if (r.mode === 'single') {
    for (let i = from; i <= to; i++) out[key('single')][i] = r.singleSlope * (i - r.start) + r.singleB;
  }
}

/**
 * 两点连线：突破后出现的「新高点」与突破前的「前一个高点」用绝对点连成新线。
 * 生成的是和 fitWindow 同形状的单线候选，可直接复用校验、绘制、去重与配色。
 */
function makePairLine(bars, A, B, isRes, meanATR, tol, extAfter, extBefore, cap) {
  if (!A || !B || B.i - A.i < 3 || B.i >= bars.length) return null;
  const slope = (B.v - A.v) / (B.i - A.i);
  if (Math.abs(slope) > 0.35 * meanATR) return null;   // 过陡通常是噪声，不是趋势线
  const r = {
    mode: 'single', prim: isRes ? 'upper' : 'lower', dir: isRes ? -1 : 1,
    start: A.i, m: B.i - A.i + 1, meanATR, tol,
    singleSlope: slope, singleB: A.v, score: 0, rank: 0,
    touchPoints: { single: [{ i: A.i, v: A.v }, { i: B.i, v: B.v }] },
    metrics: {
      containment: NaN, widthATR: 0, span: B.i - A.i + 1,
      nUp: isRes ? 2 : 0, nDn: isRes ? 0 : 2,
      slopeATR: slope / meanATR, score: 0, window: B.i - A.i + 1, breakout: true,
    },
    extAfter, extBefore, variants: [], breakout: true,
    best: null, ph: [], pl: [], w: [], slopes: [], gap: 6, pickPeaks: null,
  };
  return candidateValid(r, bars, cap) ? r : null;
}

const extParams = p => {
  const extAfter = clamp(Math.round(Number(p.extend) || 0), 0, CH_EXTEND_MAX);
  return { extAfter, extBefore: Math.min(8, Math.round(extAfter / 2)) };
};
const localAtr = (atrAll, i, fallback) => Number.isFinite(atrAll[i]) ? atrAll[i] : fallback;

/**
 * 已有轨道被有效突破后：取突破后的新摆动高点/低点，与突破前最后一个触点连成新线。
 * 旧线本身由 drawRange 在突破处截断，不再向未来延长。
 */
function breakoutLines(bars, atrAll, p, len, refs, cap) {
  const { extAfter, extBefore } = extParams(p);
  const out = [];
  const push = r => {
    if (!r) return;
    const sig = lineSignature(r, len);
    if (sig && !out.some(x => similarLine(x.sig, sig))) out.push({ r, sig });
  };
  for (const c of refs) {
    const r = c.r;
    const tp = [].concat(r.touchPoints.upper || [], r.touchPoints.lower || [], r.touchPoints.single || []);
    if (tp.length < 2) continue;
    const lastTouch = Math.max(...tp.map(x => x.i));
    const isRes = r.prim !== 'lower';
    const atr = r.meanATR || 1;
    const tol = r.tol || 0.45 * atr;
    let bi = -1;
    const scanTo = Math.min(len - 1, lastTouch + 80);
    for (let i = lastTouch + 1; i <= scanTo; i++) {
      const over = isRes
        ? bars[i].close - lineValueAt(r, i)
        : lineValueAt(r, i) - bars[i].close;
      if (over <= 0.35 * localAtr(atrAll, i, atr)) continue;
      const over2 = i + 1 < len
        ? (isRes ? bars[i + 1].close - lineValueAt(r, i + 1) : lineValueAt(r, i + 1) - bars[i + 1].close)
        : 0;
      if (over > 0.9 * localAtr(atrAll, i, atr) || over2 > 0.15 * localAtr(atrAll, i + 1, atr)) { bi = i; break; }
    }
    if (bi < 0) continue;

    // 突破后的新摆动极值，后面要有像样回落/反弹确认它确实是「新的高点/低点」。
    const end = Math.min(len - 1, bi + 60);
    let bestI = bi, bestV = isRes ? -Infinity : Infinity;
    for (let i = bi; i <= end; i++) {
      const v = isRes ? bars[i].high : bars[i].low;
      if (isRes ? v > bestV : v < bestV) { bestV = v; bestI = i; }
    }
    let pulled = len - 1 - bestI < 2;
    for (let i = bestI + 1; i < len && !pulled; i++) {
      const a = localAtr(atrAll, i, atr);
      pulled = isRes ? bars[i].low < bestV - 0.5 * a : bars[i].high > bestV + 0.5 * a;
    }
    if (!pulled) continue;
    const before = tp.filter(x => x.i <= bi).sort((a, b) => b.i - a.i)[0];
    if (!before || bi - before.i > 120) continue;
    push(makePairLine(bars, before, { i: bestI, v: bestV }, isRes,
      atr, tol, extAfter, extBefore, cap));
  }
  return out.map(x => x.r);
}

/**
 * 保底：把最近几组相邻的同侧支点（高点↔高点 / 低点↔低点）直接连成两点线。
 * 只要新的摆动点出现，就和前面那个点连一条线；通过校验与去重后才真正画出来。
 */
function pivotPairLines(bars, atrAll, p, len, cap) {
  const look = Math.min(len, clamp(Number(p.n) > 0 ? Math.round(p.n) : 320, 120, 500));
  const from = len - look;
  const seg = bars.slice(from);
  const av = atrAll.slice(from).filter(Number.isFinite);
  const meanATR = av.length ? av.reduce((a, b) => a + b, 0) / av.length : 1;
  const tol = clamp(Number(p.tol) > 0 ? Number(p.tol) : 0.45, 0.1, 2) * meanATR;
  const zzMult = clamp(Number(p.zz) > 0 ? Number(p.zz) : 2, 0.5, 10);
  const thr = seg.map((_, i) => zzMult * localAtr(atrAll, from + i, meanATR));
  const piv = zigzag(seg.map(b => b.high), seg.map(b => b.low), thr)
    .slice(1).map(x => ({ i: from + x.i, v: x.v, kind: x.kind }));
  const { extAfter, extBefore } = extParams(p);
  const out = [];
  for (const isRes of [true, false]) {
    const pts = piv.filter(x => x.kind === (isRes ? 'H' : 'L'));
    for (let k = Math.max(1, pts.length - 3); k < pts.length; k++) {
      const A = pts[k - 1], B = pts[k];
      if (B.i - A.i < 4) continue;
      let extreme = isRes ? Infinity : -Infinity;
      for (let i = A.i; i <= B.i; i++) extreme = isRes
        ? Math.min(extreme, bars[i].low) : Math.max(extreme, bars[i].high);
      const swing = isRes ? B.v - extreme : extreme - B.v;
      if (swing < 0.8 * meanATR) continue;      // 中间要有像样的反向摆动
      const r = makePairLine(bars, { i: A.i, v: A.v }, { i: B.i, v: B.v },
        isRes, meanATR, tol, extAfter, extBefore, cap);
      if (r) out.push(r);
    }
  }
  return out.sort((a, b) => (b.start + b.m) - (a.start + a.m)).slice(0, 4);
}

/**
 * 显著摆动点：ZigZag 支点按「前后两段反向摆动幅度」分级。
 * level 越高代表这个高点/低点越主要（用户说的「更显著的高点和低点」）。
 * 与 fitWindow 的小支点不同，这里保留第一个支点，且用整段行情量级衡量显著性，
 * 避免大阈值 ZigZag 把 05-11 这类「全段最高点」当成初始化噪声丢掉。
 */
function majorPivots(bars, atrAll, p, len) {
  // 默认只看最近 200 根（约等于当前可见区间）：大级别通道必须锚在眼前这段行情上，
  // 否则会连到几百根之前的历史顶底，线横穿整个画面并把价格轴拉飞。
  const look = clamp(Number(p.n) > 0 ? Math.round(p.n) : 200, 120, 600);
  const from = Math.max(0, len - look);
  const seg = bars.slice(from);
  const av = atrAll.slice(from).filter(Number.isFinite);
  const meanATR = av.length ? av.reduce((a, b) => a + b, 0) / av.length : 1;
  const zzMult = clamp(Number(p.zz) > 0 ? Number(p.zz) : 2, 0.5, 10);
  const thr = seg.map((_, i) => zzMult * localAtr(atrAll, from + i, meanATR));
  const piv = zigzag(seg.map(b => b.high), seg.map(b => b.low), thr)
    .map(x => ({ i: from + x.i, v: x.v, kind: x.kind }));
  const maxH = Math.max(...seg.map(b => b.high));
  const minL = Math.min(...seg.map(b => b.low));
  for (let k = 0; k < piv.length; k++) {
    const cur = piv[k], prev = piv[k - 1], next = piv[k + 1];
    const l = prev ? Math.abs(cur.v - prev.v) / meanATR : 6;
    const r = next ? Math.abs(cur.v - next.v) / meanATR : 6;
    cur.prom = Math.min(l, r);
    cur.level = 1 + (cur.prom >= 2 ? 1 : 0) + (cur.prom >= 3.5 ? 1 : 0) + (cur.prom >= 5.5 ? 1 : 0);
    if ((cur.kind === 'H' && cur.v >= maxH - 1e-9) || (cur.kind === 'L' && cur.v <= minL + 1e-9)) {
      cur.level = Math.min(4, cur.level + 1);
    }
  }
  return { from, look, meanATR, piv };
}

/**
 * 大级别轨道的主体段校验：两锚点之间允许影线毛刺与零星小幅收盘穿越，
 * 但不允许连续 3 根有效站上（跌破）或单根大幅穿越。
 * 锚点之后的外推段不在此校验（由 drawRange 在真正突破处截断）。
 */
function majorValid(bars, lo, hi, at, isRes, atr) {
  let streak = 0, breaks = 0;
  for (let i = lo; i <= hi; i++) {
    const over = isRes ? bars[i].close - at(i) : at(i) - bars[i].close;
    if (over > 0.35 * atr) {
      streak++; breaks++;
      if (over > 1.5 * atr || streak >= 3 || breaks > 3) return false;
    } else streak = 0;
  }
  return true;
}

/**
 * 大级别通道线：用显著高点/低点两两连成主轨，再找一个反向显著支点
 * 平移出平行副轨，组成用户手画的那类「从最显著顶底出发」的长通道。
 * 打分同时看支点级别、主体段贴合度、跨度与触点，避免退化成贴着一堆小点的短线。
 * 主轨与副轨作为「一组」返回，选线时同进同出；绘制区间交给 drawRange 按触点收口。
 */
function majorLines(bars, atrAll, p, len, wantedDirs) {
  const { from, look, meanATR, piv } = majorPivots(bars, atrAll, p, len);
  const minLevel = clamp(Math.round(Number(p.majorLevel) || 2), 1, 4);
  const anchors = piv.filter(x => x.level >= minLevel);
  const { extAfter, extBefore } = extParams(p);
  const maxSlope = 0.35 * meanATR;
  const groups = [];

  const makeRail = (A, B, slope, b0, isRes, majSide, touches, score, pairId, colorIdx) => ({
    mode: 'single', prim: majSide === 'lower' ? 'lower' : 'upper',
    dir: isRes ? -1 : 1, start: A.i, m: B.i - A.i + 1,
    meanATR, tol: 0.5 * meanATR,
    singleSlope: slope, singleB: b0, score, rank: score,
    touchPoints: { single: touches.map(t => ({ i: t.i, v: t.v })) },
    metrics: {
      containment: NaN, widthATR: 0, span: B.i - A.i + 1,
      nUp: isRes ? touches.length : 0, nDn: isRes ? 0 : touches.length,
      slopeATR: slope / meanATR, score, window: B.i - A.i + 1,
      major: true, majSide,
    },
    extAfter, extBefore, variants: [],
    major: true, majSide, pairId, colorIdx,
    best: null, ph: [], pl: [], w: [], slopes: [], gap: 6, pickPeaks: null,
  });

  for (const isRes of [true, false]) {
    if (!wantedDirs.includes(isRes ? -1 : 1)) continue;
    const pts = anchors.filter(x => x.kind === (isRes ? 'H' : 'L'));
    const others = piv.filter(x => x.kind !== (isRes ? 'H' : 'L'));
    const cands = [];
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        const A = pts[a], B = pts[b];
        const di = B.i - A.i;
        if (di < 12 || di > look * 0.85) continue;
        const slope = (B.v - A.v) / di;
        if (Math.abs(slope) > maxSlope) continue;
        const at = i => A.v + slope * (i - A.i);
        if (!majorValid(bars, A.i, B.i, at, isRes, meanATR)) continue;

        // 主体段贴合度：K 线到轨道的平均距离（ATR 归一）。
        // 只连两个端点、中间大段悬空的「平缓长线」会在这里被明显扣分。
        let gapSum = 0, gapN = 0;
        for (let i = A.i; i <= B.i; i++) {
          const d = isRes ? at(i) - bars[i].high : bars[i].low - at(i);
          if (d > 0) { gapSum += d; gapN++; }
        }
        const gapATR = gapN ? gapSum / gapN / meanATR : 3;
        const touches = pts.filter(q => q.i >= A.i && q.i <= B.i
          && Math.abs(at(q.i) - q.v) <= 0.6 * meanATR);
        const score = 26 * (A.level + B.level) + 10 * Math.min(A.prom, B.prom)
          + 0.45 * Math.min(di, 120) + 16 * touches.length + 230 * Math.exp(-gapATR / 1.4)
          - 38 * gapATR + 55 * (B.i - from) / look;

        // 平行副轨：找一个反向显著支点，让另一条轨严格经过它。
        let bestC = null, bestCScore = -Infinity;
        for (const C of others) {
          if (C.i < A.i - 8 || C.i > B.i + 45) continue;
          const b2 = C.v - slope * (C.i - A.i);
          const width = isRes ? A.v - b2 : b2 - A.v;
          if (width < 1.2 * meanATR || width > 14 * meanATR) continue;
          const at2 = i => b2 + slope * (i - A.i);
          if (!majorValid(bars, A.i, B.i, at2, !isRes, meanATR)) continue;
          const near = others.filter(q => q.i >= A.i && q.i <= Math.min(B.i + 45, len - 1)
            && Math.abs(at2(q.i) - q.v) <= 0.6 * meanATR).length;
          const cs = 12 * C.level + 14 * near - 0.02 * Math.abs(C.i - A.i);
          if (cs > bestCScore) { bestCScore = cs; bestC = C; }
        }
        cands.push({ A, B, slope, score, touches, bestC, isRes });
      }
    }
    cands.sort((x, y) => y.score - x.score);
    // 同一个显著起点最多留 2 组，并按起点交错取：先保证不同区域各有一条通道，
    // 再补同起点的不同角度（同一个支点仍可被多条线穿过）。
    const byA = new Map();
    for (const c of cands) {
      const arr = byA.get(c.A.i) || [];
      if (arr.length < 2) { arr.push(c); byA.set(c.A.i, arr); }
    }
    const top = [];
    for (let k = 0; top.length < 4; k++) {
      let added = false;
      for (const arr of byA.values()) {
        if (arr[k]) { top.push(arr[k]); added = true; if (top.length >= 4) break; }
      }
      if (!added) break;
    }
    for (let ci = 0; ci < top.length; ci++) {
      const c = top[ci];
      const { A, B, slope, score, touches, bestC, isRes } = c;
      const pairId = `${isRes ? 'r' : 's'}${A.i}-${B.i}`;
      // 主轨的两个锚点本身就在触点上，至少 2 个触点。
      const rails = [makeRail(A, B, slope, A.v, isRes, isRes ? 'upper' : 'lower',
        touches, score, pairId, ci)];
      if (bestC) {
        const b2 = bestC.v - slope * (bestC.i - A.i);
        const at2 = i => b2 + slope * (i - A.i);
        const t2 = others.filter(q => q.i >= A.i && q.i <= Math.min(B.i + 45, len - 1)
          && Math.abs(at2(q.i) - q.v) <= 0.6 * meanATR);
        // 副轨必须真的穿过至少两个支点，且至少一个落在主轨区间内；
        // 只有一个落点的平行轨就是「一条线只穿一个圈」的废线（图 1），直接不要。
        if (t2.length >= 2 && t2.some(q => q.i >= A.i && q.i <= B.i)) {
          rails.push(makeRail(A, B, slope, b2, isRes, isRes ? 'lower' : 'upper',
            t2, score - 1, pairId, ci));
        }
      }
      groups.push({ rails, isRes, pairId, colorIdx: ci, score });
    }
  }

  return groups.sort((a, b) => b.score - a.score);
}

function windowsFor(len, p) {
  if (p.n > 0) return [clamp(Math.round(p.n), 40, len)];
  // 尺度上限固定 500，且绝不把「全量数据窗口」当候选：
  // 长窗口的触点会落在几百根之前，线从历史一路画过来，看起来"前面画太长/画错"。
  // 短尺度优先保证锚点集中在眼前这一段，同时 + 增加条数时仍可给出不同斜率的线。
  const candidates = [120, 200, 320, 500];
  const windows = candidates.filter(w => w <= len);
  return windows.length ? windows : [len];
}

/** 旧接口：只返回最近/最优的一条。保留给外部与回归测试。 */
export function autoChannel(bars, p = {}) {
  const len = bars.length;
  const out = emptySupportResult(len);
  if (len < 30) return out;
  const atrAll = atr(bars, clamp(Math.round(p.atrN || 14), 2, 100));
  let winner = null;
  for (const m of windowsFor(len, p)) {
    const r = fitWindow(bars, atrAll, p, len - m, m);
    if (r && (!winner || r.rank > winner.rank)) winner = r;
  }
  if (!winner) return out;
  applyWinner(out, winner, bars);
  return out;
}

function applyWinner(out, r, bars) {
  out.mode = r.mode;
  out.prim = r.prim;
  out.touchPoints = r.touchPoints;
  out.metrics = r.metrics;
  paintCandidate(out, r, '', bars);
  out.supports = [{
    id: 0, mode: r.mode, prim: r.prim, dir: r.dir || 0,
    start: r.start, end: r.start + r.m,
    rank: r.rank, metrics: r.metrics, touchPoints: r.touchPoints,
    upper: out.upper, lower: out.lower, mid: out.mid, single: out.single,
  }];
}

/** count 上限，与参数声明的 0..12 保持一致。 */
const MAX_COUNT = 12;
/**
 * 候选池目标条数 / 最多回溯的窗口组数。
 * 池子大小必须与 count 无关：count=1..12 取的是同一个有序池的前缀，
 * 这样「+」永远是在近端之外追加更早的一条，「−」永远是先砍掉最早的一条。
 */
const POOL_TARGET = 30;
const POOL_GROUPS = 6;
/** 两个触点至少要隔开这么多根 K 线，否则只是「贴着一小段噪声」的短线。 */
const MIN_TOUCH_SPAN = 10;

/** 线的方向：通道取主轨所在侧（下轨=支撑 / 上轨=压力），单线用拟合方向。 */
const dirOfRail = r => (r.dir ? r.dir : (r.prim === 'lower' ? 1 : -1));

/**
 * 多条支撑/阻力线：严格「最近优先」。
 * - 所有候选（大级别通道、突破重连线、局部支点线）进同一个池，按「最后一个触点」
 *   从新到旧排序；count=N 就是取前 N 个，因此加减线是稳定的前缀关系。
 * - 大级别通道的上下轨算一组，同进同出，不会只冒出孤零零的一条轨。
 * - 每条线至少要有 2 个触点；只穿过一个点的线直接丢弃。
 * - side=3 时支撑与压力分别计数，每类各 count 组。
 * - 绘制区间由触点跨度决定（见 drawRange），不会横穿整个画面。
 */
export function autoSupports(bars, p = {}) {
  const len = bars.length;
  const out = emptySupportResult(len);
  const count = clamp(Math.round(Number(p.count) || 0), 0, MAX_COUNT);
  if (count === 0 || len < 30) return out;

  const atrAll = atr(bars, clamp(Math.round(p.atrN || 14), 2, 100));
  const scales = windowsFor(len, p);
  const step = Math.max(30, Math.round(scales[0] * 0.75));
  const side = clamp(Math.round(Number(p.side) || 0), 0, 3);
  // trend=0 且没有勾选支撑/压力时，连"按形态"的局部趋势线也不画（菜单里全不勾 => 一条线都没有）。
  const trendOn = Number(p.trend ?? 1) !== 0;
  // side=3：支撑与压力分别拟合，每类各 count 组；其余按总数 count 组。
  const dirs = side === 3 ? [1, -1]
    : side === 1 ? [1]
      : side === 2 ? [-1]
        : (trendOn ? [0] : []);
  const wantedDirs = side === 1 ? [1] : side === 2 ? [-1] : [1, -1];
  const majorOn = Number(p.major) !== 0;
  const breakoutOn = Number(p.breakout) !== 0;
  const perClass = side === 3;
  const cap = len + CH_EXTEND_MAX - 1;

  // 最近一组若全部拟合失败，放宽门槛重试，保证第一条仍锚定最新行情。
  const relax = {
    ...p,
    minTouch: Math.max(2, Math.round(p.minTouch || 3) - 1),
    tol: clamp(Number(p.tol || 0.45) * 1.5, 0.1, 2),
    zz: Math.max(0.6, Number(p.zz || 2) * 0.7),
  };

  /** 拟合「以 end 为末端」的所有尺度窗口 × 方向，展开多斜率变体。 */
  const fitGroup = (end, params) => {
    const list = [];
    for (const m of scales) {
      const start = end - m;
      if (start < 0) continue;
      for (const d of dirs) {
        const r = fitWindow(bars, atrAll, params, start, m, d);
        if (!r) continue;
        // 通道拟合与方向无关，两个方向会产生完全相同的上下轨：
        // 这里不过早丢弃，交给后面的线签名去重。
        for (const v of [r, ...(r.variants || [])]) list.push({ r: v, dir: d });
      }
    }
    return list;
  };

  // ---------- 候选池 ----------
  const pool = [];
  const addUnit = rails => {
    const rows = [];
    for (const r of rails) {
      if (!r) continue;
      const tp = allTouchPoints(r);
      // 只穿过一个点的线给不出任何结论（图 1 那根「一个圈」的线），直接丢弃；
      // 两个触点挨得太近（< MIN_TOUCH_SPAN 根）同样视为噪声短线。
      if (tp.length < 2) continue;
      const lo = Math.min(...tp.map(t => t.i));
      const hi = Math.max(...tp.map(t => t.i));
      if (hi - lo < MIN_TOUCH_SPAN) continue;
      const sig = lineSignature(r, len);
      if (!sig) continue;
      rows.push({ r, sig, tp, span: hi - lo });
    }
    if (!rows.length) return;
    const all = rows.reduce((a, x) => a.concat(x.tp), []);
    const firstTouch = Math.min(...all.map(x => x.i));
    const lastTouch = Math.max(...all.map(x => x.i));
    pool.push({
      rows,
      dir: dirOfRail(rows[0].r),
      major: rows.some(x => x.r.major),
      firstTouch,
      lastTouch,
      span: Math.max(...rows.map(x => x.span)),
      rank: Math.max(...rows.map(x => x.r.rank || 0)),
    });
  };

  // 1) 大级别通道：主轨 + 副轨作为一组。
  if (majorOn) {
    for (const g of majorLines(bars, atrAll, p, len, wantedDirs)) addUnit(g.rails);
  }

  // 2) 以最新 K 线为末端的局部候选（最靠近当前行情），同时作为突破重连的参考轨道。
  const baseGroup = (() => {
    const g = fitGroup(len, p);
    return g.length ? g : fitGroup(len, relax);
  })();
  for (const c of baseGroup) addUnit([c.r]);

  // 3) 突破后重连 + 相邻同侧支点保底：新出现的高点一定和前面连一条。
  if (breakoutOn) {
    // 只保留当前选定的方向：仅压力/仅支撑时不能冒出另一侧的线。
    const dirOk = d => side === 0 || (side & (d > 0 ? 1 : 2)) !== 0;
    const refs = pool.flatMap(u => u.rows.map(x => ({ r: x.r })));
    const extra = [
      ...breakoutLines(bars, atrAll, p, len, refs, cap),
      ...pivotPairLines(bars, atrAll, p, len, cap),
    ].filter(r => dirOk(r.dir));
    for (const r of extra) addUnit([r]);
  }

  // 4) 更早的窗口末端：count 增大时用来「往前追溯」，池子够大就停。
  for (let end = len - step, g = 0;
    end >= 30 && pool.length < POOL_TARGET && g < POOL_GROUPS;
    end -= step, g++) {
    for (const c of fitGroup(end, p)) addUnit([c.r]);
  }

  // ---------- 选择：最近优先的有序前缀 ----------
  // 1) 先看「最后一个触点」有多新 —— 这是线的时效性；
  // 2) 同样新时，跨度更长的线（覆盖的行情更多）优先；
  // 3) 最后才看质量分。
  // count=N 取前 N 个，所以 +1 追加的一定是更早的一条，−1 砍掉的一定是最早的一条。
  pool.sort((a, b) =>
    b.lastTouch - a.lastTouch
    || b.span - a.span
    || b.rank - a.rank
    || (b.rows[0].r.start + b.rows[0].r.m) - (a.rows[0].r.start + a.rows[0].r.m));

  // 先在类内去重：与前面更近的线几乎重合的，保留更近的那条。
  // 去重必须发生在配额之前 —— 否则同一个 count 下被去重掉的候选会改变后续线的位置，
  // 加减一条线时整排线都会跟着移位。
  const dedupe = list => {
    const out = [];
    for (const u of list) {
      const rows = u.rows.filter(x => !out.some(o => o.rows.some(y => similarLine(x.sig, y.sig))));
      if (!rows.length) continue;
      const all = rows.reduce((a, x) => a.concat(x.tp), []);
      out.push({
        ...u, rows,
        firstTouch: Math.min(...all.map(x => x.i)),
        lastTouch: Math.max(...all.map(x => x.i)),
      });
    }
    return out;
  };

  // side=3：支撑/压力各自按最近优先排队，再固定「支撑、压力、支撑、压力…」交替合并。
  // 必须按位置交替而不是按先后：某一类先被配额挡住时，count 一变后面的线就会整体移位，
  // 用户看到的就是「加减线顺序乱」。
  let seq;
  if (perClass) {
    const sup = dedupe(pool.filter(u => u.dir > 0));
    const res = dedupe(pool.filter(u => u.dir <= 0));
    seq = [];
    for (let i = 0, j = 0, turn = 0; i < sup.length || j < res.length; turn ^= 1) {
      if ((turn === 0 && i < sup.length) || j >= res.length) seq.push(sup[i++]);
      else seq.push(res[j++]);
    }
  } else {
    seq = dedupe(pool);
  }

  // 取前缀：每类各 count 组（side=3），或总共 count 组。
  let picked;
  if (perClass) {
    const left = { sup: count, res: count };
    picked = [];
    for (const u of seq) {
      const cls = u.dir > 0 ? 'sup' : 'res';
      if (left[cls] <= 0) continue;
      picked.push(u);
      left[cls]--;
      if (left.sup <= 0 && left.res <= 0) break;
    }
  } else {
    picked = seq.slice(0, count);
  }
  if (!picked.length) return out;

  // ---------- 输出：按选中的顺序展开成一条条轨 ----------
  const rails = [];
  for (const u of picked) {
    for (const x of u.rows) {
      const tp = x.tp;
      rails.push({
        r: x.r, dir: dirOfRail(x.r),
        lastTouch: Math.max(...tp.map(t => t.i)),
        firstTouch: Math.min(...tp.map(t => t.i)),
      });
    }
  }

  applyWinner(out, picked[0].rows[0].r, bars);
  const width = len + CH_EXTEND_MAX;
  out.supports = rails.map((c, idx) => {
    const r = c.r;
    const s = {
      id: idx, mode: r.mode, prim: r.prim, dir: c.dir,
      major: !!r.major, majSide: r.majSide || null, colorIdx: r.colorIdx ?? null,
      start: r.start, end: r.start + r.m,
      rank: r.rank, metrics: { ...r.metrics, lastTouch: c.lastTouch, firstTouch: c.firstTouch, breakout: !!r.breakout },
      touchPoints: r.touchPoints,
      upper: new Array(width).fill(NaN), lower: new Array(width).fill(NaN),
      mid: new Array(width).fill(NaN), single: new Array(width).fill(NaN),
    };
    paintCandidate(s, r, '', bars);
    return s;
  });
  return out;
}

/**
 * 线的几何签名：斜率 + 任意绝对索引上的价格 + 触点集合。
 * 不再只比较「窗口末端」，否则同一组锚点在不同尺度窗口里会各画一条几乎重合的线。
 */
function lineSignature(r, len) {
  const meanATR = r.meanATR || 1;
  const tp = [].concat(r.touchPoints.upper || [], r.touchPoints.lower || [], r.touchPoints.single || []);
  const slope = r.mode === 'channel' ? r.best.slope : r.singleSlope;
  const base = r.mode === 'channel'
    ? (r.prim === 'lower' ? r.best.dn.b : r.best.up.b)
    : r.singleB;
  // 用「实际绘制区间」而非「触点跨度」做重叠比较：两条线即使触点不同，
  // 只要在视野里几乎重合，就应判为重复。
  const cap = (len || r.start + r.m) + CH_EXTEND_MAX - 1;
  const { from, to } = drawRange(r, cap, null, false);
  return {
    slope, meanATR,
    at: i => slope * (i - r.start) + base,
    end: r.start + r.m,
    first: from, last: Math.min(to, len - 1),
    anchors: tp.map(x => x.i),
    kind: (r.prim === 'lower' || (r.mode === 'single' && r.dir > 0)) ? 'sup' : 'res',
  };
}

/**
 * 判重：两类线必须是同一侧（支撑/压力）才比较。
 * 1) 重叠区间内价格始终几乎一样、斜率也几乎一样 —— 无论窗口末端是否相同都算重复；
 * 2) 一条线的全部触点都已被另一条线覆盖（≥2 个）—— 它没有提供任何新信息；
 * 3) 共用 ≥2 个锚点且在这些点上的价格也几乎一致；
 * 4) 旧口径（同窗口末端 + 末端价格/斜率一致）。
 * 只共用 1 个锚点、角度明显不同的线仍保留（同一个支点允许多条线穿过）。
 */
function similarLine(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  const atr = Math.max(a.meanATR, b.meanATR) || 1;
  const lo = Math.max(a.first, b.first), hi = Math.min(a.last, b.last);
  if (hi - lo >= 8) {
    let maxDiff = 0;
    for (let k = 0; k <= 10; k++) {
      const i = lo + (hi - lo) * k / 10;
      maxDiff = Math.max(maxDiff, Math.abs(a.at(i) - b.at(i)));
    }
    if (maxDiff <= 0.6 * atr && Math.abs(a.slope - b.slope) <= 0.04 * atr) return true;
  }
  const shared = a.anchors.filter(i => b.anchors.some(j => Math.abs(i - j) <= 2));
  // 触点集合被完全包含：同一条线在不同窗口里拟合出来的「双胞胎」。
  // 之前只比价格，同一组支点拟合出的截距差一点就都留下，画面上是几条叠在一起的平行线。
  if (shared.length >= 2
    && shared.length >= Math.min(a.anchors.length, b.anchors.length)) return true;
  if (shared.length >= 2 && shared.every(i => Math.abs(a.at(i) - b.at(i)) <= 0.35 * atr)) return true;
  if (Math.abs(a.end - b.end) <= 2
    && Math.abs(a.at(a.end - 1) - b.at(b.end - 1)) <= 0.2 * atr
    && Math.abs(a.slope - b.slope) <= 0.008 * atr) return true;
  return false;
}
