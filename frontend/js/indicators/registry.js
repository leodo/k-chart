import {
  sma, tdxSma, ema, wilder, stddev, highest, lowest, closes, trueRange, autoSupports,
} from './helpers.js';
import { computeMOS, MOS_LINE_DEFS } from './mos.js';

/**
 * 指标注册表：新增指标只需声明 params / lines / title / compute 并注册于此。
 * - params: 输入项元数据 [{key, label, def, min, max, tip?, step?}]
 * - lines(p): 线条元数据 [{key, label, color, type?}]，供样式面板与图例使用
 * - title(p): 图例上的指标名（带当前参数）
 * - compute(bars, p): 返回 { lines: [{...meta, values}] }
 *
 * 所有指标实例各自持有 params/style，引擎按「指标 + 参数」隔离缓存。
 */
const P = (key, label, def, min, max, tip = '', step = 1, options = null) => ({ key, label, def, min, max, tip, step, options });
const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};
// 第 0 条用旧 key 兼容已保存布局的颜色设置；之后的支撑轮换配色，便于区分先后。
const CH_SUPPORT_COLORS = [
  { upper: '#f0515a', lower: '#2eb87c', mid: '#8a94a6', single: '#4c9aff' },
  { upper: '#ff9800', lower: '#26a69a', mid: '#7d8798', single: '#c792ea' },
  { upper: '#e91e63', lower: '#8bc34a', mid: '#6b7482', single: '#00bcd4' },
  { upper: '#c792ea', lower: '#009688', mid: '#5a6270', single: '#ffb300' },
];
// 大级别通道单独用一组暖色：上下轨同色系，视觉上能看出「这是一组平行通道」。
const CH_MAJOR_COLORS = [
  { upper: '#ff6b4a', lower: '#ff9a5c', mid: '#8a94a6', single: '#ff6b4a' },
  { upper: '#f0515a', lower: '#ff8a65', mid: '#7d8798', single: '#f0515a' },
  { upper: '#ff9800', lower: '#ffb74d', mid: '#6b7482', single: '#ff9800' },
  { upper: '#e91e63', lower: '#f48fb1', mid: '#5a6270', single: '#e91e63' },
];
// 第 0 条沿用 'upper'/'lower'/'single' 旧 key，保证升级后旧布局样式不丢。
const chKey = (i, kind) => (i === 0 ? kind : `s${i}_${kind}`);

// MA 最多 10 条：长度填 0 即隐藏该条；默认启用前 3 条（5/10/20）
const MA_COLORS = [
  '#f2c14e', '#4c9aff', '#c792ea', '#2eb87c', '#f0515a',
  '#ff9800', '#00bcd4', '#e91e63', '#8bc34a', '#9b9b9b',
];
const MA_DEFAULTS = [5, 10, 20, 0, 0, 0, 0, 0, 0, 0];
const MA_PARAMS = MA_DEFAULTS.map((def, i) =>
  P(`p${i + 1}`, `长度 ${i + 1}`, def, 0, 999, '0 表示不显示'));

export const REGISTRY = {
  ma: {
    id: 'ma', name: '均线 MA', short: 'MA', kind: 'overlay',
    // 10 条均线；长度为 0 表示不显示该条。默认启用前 3 条。
    params: MA_PARAMS,
    lines: p => MA_COLORS
      .map((color, i) => ({ key: `ma${i + 1}`, len: p[`p${i + 1}`], color }))
      .filter(x => x.len > 0)
      .map(x => ({ key: x.key, label: `MA${x.len}`, color: x.color })),
    title: p => {
      const n = MA_PARAMS.map(d => p[d.key]).filter(v => v > 0);
      return n.length ? `MA(${n.join(',')})` : 'MA';
    },
    compute(bars, p) {
      const c = closes(bars);
      const active = MA_COLORS
        .map((color, i) => ({ key: `ma${i + 1}`, len: p[`p${i + 1}`], color }))
        .filter(x => x.len > 0);
      return { lines: active.map(x => ({
        key: x.key, label: `MA${x.len}`, color: x.color, values: sma(c, x.len),
      })) };
    },
  },

  ema: {
    id: 'ema', name: '指数均线 EMA', short: 'EMA', kind: 'overlay',
    params: [
      P('p1', '长度 1', 10, 1, 999), P('p2', '长度 2', 20, 1, 999), P('p3', '长度 3', 60, 1, 999),
    ],
    lines: p => [
      { key: 'ema1', label: `EMA${p.p1}`, color: '#f2c14e' },
      { key: 'ema2', label: `EMA${p.p2}`, color: '#4c9aff' },
      { key: 'ema3', label: `EMA${p.p3}`, color: '#c792ea' },
    ],
    title: p => `EMA(${p.p1},${p.p2},${p.p3})`,
    compute(bars, p) {
      const c = closes(bars);
      return { lines: this.lines(p).map((line, i) => ({ ...line, values: ema(c, p[`p${i + 1}`]) })) };
    },
  },

  boll: {
    id: 'boll', name: '布林带 BOLL', short: 'BOLL', kind: 'overlay',
    params: [
      P('n', '周期', 20, 2, 500),
      P('k', '标准差倍数', 2, 0.1, 10, '', 0.1),
    ],
    lines: () => [
      { key: 'mid', label: 'BOLL', color: '#f2c14e' },
      { key: 'upper', label: 'UPPER', color: '#4c9aff' },
      { key: 'lower', label: 'LOWER', color: '#c792ea' },
    ],
    title: p => `BOLL(${p.n},${p.k})`,
    compute(bars, p) {
      const c = closes(bars);
      const mid = sma(c, p.n);
      const sd = stddev(c, p.n);
      return { lines: [
        { key: 'mid', label: 'BOLL', color: '#f2c14e', values: mid },
        { key: 'upper', label: 'UPPER', color: '#4c9aff',
          values: mid.map((v, i) => Number.isFinite(v) && Number.isFinite(sd[i]) ? v + p.k * sd[i] : NaN) },
        { key: 'lower', label: 'LOWER', color: '#c792ea',
          values: mid.map((v, i) => Number.isFinite(v) && Number.isFinite(sd[i]) ? v - p.k * sd[i] : NaN) },
      ] };
    },
  },

  mos: {
    id: 'mos', name: 'MOS 底部/顶部结构', short: 'MOS', kind: 'overlay',
    params: [
      P('shortN', '短期 EMA 基期', 10, 1, 200, '短期均线族的基础周期，之后逐级再做 EMA(·,3)'),
      P('longN', '长期 EMA 基期', 45, 1, 400, '长期均线族的基础周期，之后逐级再做 EMA(·,3)'),
      P('struct', '结构信号', 1, 0, 1, 'MACD 背离结构：●底部结构（品红）/ ●顶部结构（绿）', 1, [[1, '显示'], [0, '隐藏']]),
      P('timing', '时间 / 高低点标记', 1, 0, 1, '「时间」13 根新高新低、▲低点、▲高点', 1, [[1, '显示'], [0, '隐藏']]),
    ],
    // 5 条短期（品红）+ 5 条长期（红）均线族，样式面板可逐条改色/隐藏。
    lines: () => MOS_LINE_DEFS.map(({ key, label, color }) => ({ key, label, color })),
    title: p => `MOS(${p.shortN},${p.longN})`,
    compute(bars, p) { return computeMOS(bars, p); },
  },

  channel: {
    id: 'channel', name: '自动支撑 / 压力 / 通道线', short: 'CH', kind: 'overlay',
    params: [
      P('trend', '自动趋势线', 1, 0, 1, '按形态自动画趋势线/通道（方向不限）。关闭后只画下面勾选的支撑/压力/显著高低点通道/突破线；全部关闭则一条不画',
        1, [[1, '开启（按形态）'], [0, '关闭']]),
      P('side', '画线方向', 0, 0, 3, '与「自动趋势线」二选一：勾选支撑/压力表示只画该方向；自动=按形态判断',
        1, [[0, '自动（不限方向）'], [1, '仅支撑线'], [2, '仅压力线'], [3, '支撑 + 压力线（同时）']]),
      P('count', '线条组数', 1, 0, 12, '0=隐藏；+ 按最近优先往前纳入下一组，− 先收掉最早的一组；同时勾选两类时每类各 N 组'),
      P('extend', '向未来延长根数', 12, 0, 50, '线两端略作外推，右侧留白可看到未来离线多远；0=不延长'),
      P('breakout', '突破后重连', 1, 0, 1, '突破后把新的高点/低点与前面一个支点连成新线，旧线在突破处截断',
        1, [[1, '开启（推荐）'], [0, '关闭']]),
      P('major', '显著高低点通道', 1, 0, 1, '连接大级别摆动高点/低点画长通道；0=只画局部支点短线',
        1, [[1, '开启（推荐）'], [0, '关闭']]),
      P('majorLevel', '支点显著级别', 2, 1, 4, '越大越只连最显著的大顶/大底，1=包含次级摆动点',
        1, [[1, '1 全部支点'], [2, '2 主要支点'], [3, '3 大级别'], [4, '4 只连最大顶底']]),
      P('n', '回看根数', 0, 0, 2000, '0=全部数据；或只用最近 N 根'),
      P('atrN', 'ATR 周期', 14, 2, 100, '所有阈值以 ATR 归一'),
      P('zz', 'ZigZag 倍数', 2, 0.5, 10, '转折点反转阈值 = 倍数 × ATR', 0.1),
      P('tol', '触点容差 ATR', 0.45, 0.1, 2, '支点离轨道多近算触及', 0.05),
      P('minTouch', '最少触点', 3, 2, 12, '总触点不足则退化为单趋势线'),
    ],
    // 样式面板按 count 展开实际会画的线；第 0 条沿用旧 key，兼容已保存布局。
    lines: p => {
      const count = clampInt(p.count, 0, 12, 1);
      const side = clampInt(p.side, 0, 3, 0);
      // 突破重连线与显著高低点通道是附加的，多预留几组样式/可见性 key。
      const majorRows = Number(p.major) === 0 ? 0
        : clampInt(p.count, 2, 4) * (side === 1 || side === 2 ? 1 : 2);
      const rowsCount = count + (Number(p.breakout) === 0 ? 0 : 2) + majorRows;
      const rows = [];
      for (let i = 0; i < rowsCount; i++) {
        // 大级别通道排在最前，上下轨成对用同一组暖色；渲染层以样式色为准，
        // 所以配色必须在这里注册，而不能只在 compute 里改 line.color。
        const c = i < majorRows
          ? CH_MAJOR_COLORS[Math.floor(i / 2) % CH_MAJOR_COLORS.length]
          : CH_SUPPORT_COLORS[i % CH_SUPPORT_COLORS.length];
        if (side !== 2) rows.push({ key: chKey(i, 'lower'), label: `支撑${i + 1}线`, color: c.lower });
        if (side !== 1) rows.push({ key: chKey(i, 'upper'), label: `压力${i + 1}线`, color: c.upper });
        if (side === 0) rows.push({ key: chKey(i, 'mid'), label: `中轨${i + 1}`, color: c.mid });
        rows.push({ key: chKey(i, 'single'), label: `趋势线${i + 1}`, color: c.single });
      }
      return rows;
    },
    // 「按形态自动」与「指定方向」互斥：指定了方向就把自动关掉，
    // 否则设置面板显示的状态会和实际画的线对不上。
    normalize(p) { if (p.side !== 0) p.trend = 0; return p; },
    title: p => {
      const n = clampInt(p.count, 0, 12, 1);
      const s = clampInt(p.side, 0, 3, 0);
      const tag = s === 1 ? '支撑' : s === 2 ? '压力' : s === 3 ? '支撑+压力' : '通道';
      return `CH${tag}×${n}(${p.atrN},${p.zz},${p.tol})`;
    },
    compute(bars, p) {
      const r = autoSupports(bars, p);
      const side = clampInt(p.side, 0, 3, 0);
      // 只产出线本身；触点圆圈已按用户要求移除（不再输出 touchGroups）。
      const lines = [];
      for (const s of r.supports) {
        const i = s.id;
        const c = (s.major
          ? CH_MAJOR_COLORS[(s.colorIdx ?? 0) % CH_MAJOR_COLORS.length]
          : CH_SUPPORT_COLORS[i % CH_SUPPORT_COLORS.length]);
        if (s.mode === 'channel') {
          // 自动模式画完整通道；仅支撑/仅压力时只取对应边轨。
          if (side !== 2) {
            lines.push({ key: chKey(i, 'lower'), label: `支撑${i + 1}下`, color: c.lower, values: s.lower });
          }
          if (side !== 1) {
            lines.push({ key: chKey(i, 'upper'), label: `压力${i + 1}上`, color: c.upper, values: s.upper });
          }
          if (side === 0) lines.push({ key: chKey(i, 'mid'), label: `中轨${i + 1}`, color: c.mid, values: s.mid });
        } else if (s.mode === 'single') {
          if (side === 0) {
            lines.push({
              key: chKey(i, 'single'),
              label: s.major
                ? `主通道${(s.colorIdx ?? i) + 1}${s.majSide === 'lower' ? '下轨' : '上轨'}`
                : `趋势线${i + 1}`,
              color: s.major ? (s.majSide === 'lower' ? c.lower : c.upper) : c.single,
              values: s.single,
            });
          } else {
            // 支撑绿、压力红；side=3 时两类独立成线，允许穿过同一个支点。
            // 大级别通道的上下轨都用暖色，且按组同色，便于看出平行关系。
            const isRes = s.dir < 0;
            const kind = isRes ? 'upper' : 'lower';
            const color = s.major
              ? (s.majSide === 'lower' ? c.lower : c.upper)
              : (isRes ? c.upper : c.lower);
            const label = s.major
              ? `主通道${(s.colorIdx ?? i) + 1}${s.majSide === 'lower' ? '下轨' : '上轨'}`
              : `${isRes ? '压力' : '支撑'}${i + 1}`;
            lines.push({ key: chKey(i, kind), label, color, values: s.single });
          }
        }
      }
      return {
        mode: r.mode, prim: r.prim, metrics: r.metrics, side,
        lines, supportCount: r.supports.length,
      };
    },
  },

  volume: {
    id: 'volume', name: '成交量 VOL', short: 'VOL', kind: 'pane',
    params: [P('ma1', '成交量均线', 0, 0, 500, '0 表示不显示')],
    lines: p => {
      const lines = [{ key: 'vol', label: 'VOL', color: '#4c9aff', type: 'hist' }];
      if (p.ma1 > 0) lines.push({ key: 'volma', label: `VOLMA${p.ma1}`, color: '#f2c14e' });
      return lines;
    },
    title: p => (p.ma1 > 0 ? `VOL(${p.ma1})` : 'VOL'),
    compute(bars, p) {
      const values = bars.map(b => b.volume || 0);
      const lines = [{
        key: 'vol', label: 'VOL', color: '#4c9aff', type: 'hist', values,
        sign: bars.map(b => (b.close >= b.open ? 1 : -1)),
      }];
      if (p.ma1 > 0) lines.push({ key: 'volma', label: `VOLMA${p.ma1}`, color: '#f2c14e', values: sma(values, p.ma1) });
      return { lines };
    },
  },

  kdj: {
    id: 'kdj', name: '随机指标 KDJ', short: 'KDJ', kind: 'pane',
    params: [P('n', '周期 N', 9, 2, 250), P('m1', 'K 平滑 M1', 3, 1, 250), P('m2', 'D 平滑 M2', 3, 1, 250)],
    lines: () => [
      { key: 'k', label: 'K', color: '#f2c14e' },
      { key: 'd', label: 'D', color: '#4c9aff' },
      { key: 'j', label: 'J', color: '#c792ea' },
    ],
    title: p => `KDJ(${p.n},${p.m1},${p.m2})`,
    compute(bars, p) {
      const n = bars.length;
      const rsv = new Array(n).fill(NaN);
      const highs = bars.map(b => b.high);
      const lows = bars.map(b => b.low);
      const c = closes(bars);
      for (let i = 0; i < n; i++) {
        const hh = highest(highs, p.n, i);
        const ll = lowest(lows, p.n, i);
        rsv[i] = hh > ll ? ((c[i] - ll) / (hh - ll)) * 100 : 50;
      }
      const k = tdxSma(rsv, p.m1, 1);
      const d = tdxSma(k, p.m2, 1);
      const j = k.map((v, i) => (Number.isNaN(v) || Number.isNaN(d[i])) ? NaN : 3 * v - 2 * d[i]);
      return { lines: [
        { key: 'k', label: 'K', color: '#f2c14e', values: k },
        { key: 'd', label: 'D', color: '#4c9aff', values: d },
        { key: 'j', label: 'J', color: '#c792ea', values: j },
      ] };
    },
  },

  macd: {
    id: 'macd', name: '指数平滑 MACD', short: 'MACD', kind: 'pane',
    params: [P('fast', '快线', 12, 1, 250), P('slow', '慢线', 26, 1, 250), P('signal', '信号', 9, 1, 250)],
    lines: () => [
      { key: 'hist', label: 'MACD', color: '#f0515a', type: 'hist' },
      { key: 'dif', label: 'DIF', color: '#4c9aff' },
      { key: 'dea', label: 'DEA', color: '#f2c14e' },
    ],
    title: p => `MACD(${p.fast},${p.slow},${p.signal})`,
    compute(bars, p) {
      const c = closes(bars);
      const fast = ema(c, p.fast);
      const slow = ema(c, p.slow);
      const dif = fast.map((v, i) =>
        Number.isFinite(v) && Number.isFinite(slow[i]) ? v - slow[i] : NaN);
      const dea = ema(dif, p.signal);
      const hist = dif.map((v, i) => Number.isFinite(v) && Number.isFinite(dea[i]) ? 2 * (v - dea[i]) : NaN);
      return { lines: [
        { key: 'hist', label: 'MACD', color: '#f0515a', type: 'hist', values: hist, sign: hist },
        { key: 'dif', label: 'DIF', color: '#4c9aff', values: dif },
        { key: 'dea', label: 'DEA', color: '#f2c14e', values: dea },
      ] };
    },
  },

  rsi: {
    id: 'rsi', name: '相对强弱 RSI', short: 'RSI', kind: 'pane',
    params: [P('n', '周期', 14, 2, 250)],
    lines: p => [{ key: 'rsi', label: `RSI${p.n}`, color: '#c792ea' }],
    title: p => `RSI(${p.n})`,
    compute(bars, p) {
      const c = closes(bars);
      const n = c.length;
      const up = new Array(n).fill(0), down = new Array(n).fill(0);
      for (let i = 1; i < n; i++) {
        const d = c[i] - c[i - 1];
        up[i] = Math.max(0, d);
        down[i] = Math.max(0, -d);
      }
      const avgUp = wilder(up, p.n), avgDown = wilder(down, p.n);
      const values = avgUp.map((u, i) => {
        const d = avgDown[i];
        return Number.isFinite(u) && Number.isFinite(d) ? (d === 0 ? 100 : 100 - 100 / (1 + u / d)) : NaN;
      });
      return { lines: [{ key: 'rsi', label: `RSI${p.n}`, color: '#c792ea', values }] };
    },
  },

  dmi: {
    id: 'dmi', name: '动向指标 DMI/ADX', short: 'DMI', kind: 'pane',
    params: [P('n', '周期 N', 14, 2, 250), P('m', 'ADX 平滑', 6, 2, 250)],
    lines: () => [
      { key: 'pdi', label: '+DI', color: '#f0515a' },
      { key: 'mdi', label: '-DI', color: '#2eb87c' },
      { key: 'adx', label: 'ADX', color: '#f2c14e' },
    ],
    title: p => `DMI(${p.n},${p.m})`,
    compute(bars, p) {
      const n = bars.length;
      const tr = new Array(n).fill(NaN), plus = new Array(n).fill(0), minus = new Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        tr[i] = trueRange(bars, i);
        if (i > 0) {
          const up = bars[i].high - bars[i - 1].high;
          const dn = bars[i - 1].low - bars[i].low;
          plus[i] = up > dn && up > 0 ? up : 0;
          minus[i] = dn > up && dn > 0 ? dn : 0;
        }
      }
      const str = wilder(tr, p.n), sp = wilder(plus, p.n), sm = wilder(minus, p.n);
      const pdi = str.map((v, i) => v > 0 ? 100 * sp[i] / v : NaN);
      const mdi = str.map((v, i) => v > 0 ? 100 * sm[i] / v : NaN);
      const dx = pdi.map((v, i) => Number.isFinite(v) && Number.isFinite(mdi[i]) && v + mdi[i] > 0
        ? 100 * Math.abs(v - mdi[i]) / (v + mdi[i]) : NaN);
      return { lines: [
        { key: 'pdi', label: '+DI', color: '#f0515a', values: pdi },
        { key: 'mdi', label: '-DI', color: '#2eb87c', values: mdi },
        { key: 'adx', label: 'ADX', color: '#f2c14e', values: wilder(dx, p.m) },
      ] };
    },
  },

  cci: {
    id: 'cci', name: '顺势指标 CCI', short: 'CCI', kind: 'pane',
    params: [P('n', '周期', 14, 2, 250)],
    lines: p => [{ key: 'cci', label: `CCI${p.n}`, color: '#4c9aff' }],
    title: p => `CCI(${p.n})`,
    compute(bars, p) {
      const tp = bars.map(b => (b.high + b.low + b.close) / 3);
      const ma = sma(tp, p.n);
      const values = tp.map((v, i) => {
        if (!Number.isFinite(ma[i])) return NaN;
        let sum = 0;
        for (let j = i - p.n + 1; j <= i; j++) sum += Math.abs(tp[j] - ma[i]);
        const md = sum / p.n;
        return md > 0 ? (v - ma[i]) / (0.015 * md) : NaN;
      });
      return { lines: [{ key: 'cci', label: `CCI${p.n}`, color: '#4c9aff', values }] };
    },
  },

  obv: {
    id: 'obv', name: '能量潮 OBV', short: 'OBV', kind: 'pane',
    params: [P('ma1', '均线', 0, 0, 500, '0 表示不显示')],
    lines: p => {
      const lines = [{ key: 'obv', label: 'OBV', color: '#4c9aff' }];
      if (p.ma1 > 0) lines.push({ key: 'obvma', label: `MA${p.ma1}`, color: '#f2c14e' });
      return lines;
    },
    title: p => (p.ma1 > 0 ? `OBV(${p.ma1})` : 'OBV'),
    compute(bars, p) {
      let acc = 0;
      const values = bars.map((b, i) => {
        if (i > 0) acc += b.close > bars[i - 1].close ? b.volume : (b.close < bars[i - 1].close ? -b.volume : 0);
        return acc;
      });
      const lines = [{ key: 'obv', label: 'OBV', color: '#4c9aff', values }];
      if (p.ma1 > 0) lines.push({ key: 'obvma', label: `MA${p.ma1}`, color: '#f2c14e', values: sma(values, p.ma1) });
      return { lines };
    },
  },

  wr: {
    id: 'wr', name: '威廉指标 W%R', short: 'W%R', kind: 'pane',
    params: [P('n', '周期', 14, 2, 250)],
    lines: p => [{ key: 'wr', label: `W%R${p.n}`, color: '#c792ea' }],
    title: p => `W%R(${p.n})`,
    compute(bars, p) {
      const highs = bars.map(b => b.high), lows = bars.map(b => b.low), c = closes(bars);
      const values = bars.map((_, i) => {
        const hh = highest(highs, p.n, i), ll = lowest(lows, p.n, i);
        return hh > ll ? -100 * (hh - c[i]) / (hh - ll) : NaN;
      });
      return { lines: [{ key: 'wr', label: `W%R${p.n}`, color: '#c792ea', values }] };
    },
  },

  trix: {
    id: 'trix', name: '三重指数 TRIX', short: 'TRIX', kind: 'pane',
    params: [P('n', '周期', 8, 2, 250), P('m', '变动周期', 3, 1, 250)],
    lines: p => [{ key: 'trix', label: `TRIX(${p.n},${p.m})`, color: '#f2c14e' }],
    title: p => `TRIX(${p.n},${p.m})`,
    compute(bars, p) {
      const c = closes(bars);
      const triple = ema(ema(ema(c, p.n), p.n), p.n);
      const values = triple.map((v, i) => {
        const prev = triple[i - p.m];
        return i >= p.m && Number.isFinite(v) && Number.isFinite(prev) && prev !== 0
          ? (v - prev) / prev * 100 : NaN;
      });
      return { lines: [{ key: 'trix', label: `TRIX(${p.n},${p.m})`, color: '#f2c14e', values }] };
    },
  },
};

/** 副图与主图叠加的可选项，供 UI 直接使用。 */
export const PANE_OPTIONS = ['volume', 'kdj', 'macd', 'rsi', 'dmi', 'cci', 'obv', 'wr', 'trix'];
export const OVERLAY_OPTIONS = ['ma', 'ema', 'boll', 'channel', 'mos'];

export function defaultParams(id) {
  const meta = REGISTRY[id];
  if (!meta) return {};
  const out = {};
  for (const p of meta.params) out[p.key] = p.def;
  return out;
}

/** 校验并归一化参数：非法值回退默认，按 step 精度裁剪到声明范围。 */
export function normalizeParams(id, input) {
  const meta = REGISTRY[id];
  if (!meta) return {};
  const out = {};
  for (const def of meta.params) {
    let v = Number(input?.[def.key]);
    if (!Number.isFinite(v)) v = def.def;
    if (def.step >= 1) v = Math.round(v);
    else {
      const digits = (String(def.step).split('.')[1] || '').length;
      v = Number(v.toFixed(digits));
    }
    if (def.min != null) v = Math.max(def.min, v);
    if (def.max != null) v = Math.min(def.max, v);
    out[def.key] = v;
  }
  // 指标可声明额外约束（如「自动趋势线」与「指定方向」互斥）。
  return typeof meta.normalize === 'function' ? meta.normalize(out) : out;
}

/** 默认样式：颜色统一用 hex 以便 <input type=color> 直接编辑。 */
export function defaultStyle(id) {
  const meta = REGISTRY[id];
  const style = { lineColors: {}, histColors: {}, visible: {}, lineWidth: 1.2, lineStyle: 'solid' };
  if (!meta) return style;
  for (const line of meta.lines(defaultParams(id))) {
    style.visible[line.key] = true;
    if (line.type === 'hist') style.histColors[line.key] = { up: '#f0515a', down: '#2eb87c' };
    else style.lineColors[line.key] = line.color;
  }
  return style;
}

/** 带版本与参数隔离的缓存引擎：同一批 bars + 同一组参数只算一次。 */
export class IndicatorEngine {
  constructor() { this.cache = new Map(); }

  get(id, bars, version, params) {
    const provider = REGISTRY[id];
    if (!provider) return null;
    const p = normalizeParams(id, params);
    const key = `${id}:${JSON.stringify(p)}`;
    // 数据指纹不能只看 version + length：切换合约/周期时两者都可能巧合相同，
    // 旧数据的指标值会被误当作新数据的结果（表现为 MA 与现价完全不在一个量级）。
    const first = bars[0], last = bars[bars.length - 1];
    const stamp = first && last
      ? `${first.ts}:${first.close}|${last.ts}:${last.close}` : 'empty';
    const cached = this.cache.get(key);
    if (cached && cached.version === version && cached.length === bars.length
      && cached.stamp === stamp) return cached.result;
    const result = provider.compute(bars, p);
    this.cache.set(key, { version, length: bars.length, stamp, result });
    if (this.cache.size > 120) this.cache.delete(this.cache.keys().next().value);
    return result;
  }

  meta(id) { return REGISTRY[id]; }
}
