import { drawGrid } from './layers/grid.js';
import { drawCandles } from './layers/candles.js';
import { drawVix } from './layers/vix.js';
import { drawIndicatorPane, drawOverlayLines } from './layers/indicator.js';
import { drawCrosshair } from './layers/crosshair.js';
import { drawOverlays, drawCompare } from './layers/overlays.js';
import { drawLegend } from './layers/legend.js';
import { IndicatorEngine } from '../indicators/registry.js';
import { PaneScale } from './panes.js';

const COLORS = {
  up: '#f0515a', down: '#2eb87c',
  upAlpha: 'rgba(240,81,90,.4)', downAlpha: 'rgba(46,184,124,.4)',
  grid: '#1b2531', axis: '#6d7c8e', text: '#d7e0ea', panel: '#111823',
};

/** 分层渲染器：一次 rAF 内画完所有面板，视口外数据全部裁剪。 */
export class Renderer {
  constructor(canvas, store, viewport, panes) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.store = store;
    this.vp = viewport;
    this.panes = panes;
    this.engine = new IndicatorEngine();
    this.crosshair = null;
    this.shapes = [];
    this.selected = null;
    this.compare = null;
    this.vix = null;
    this.hoverSetting = null;
    this.hoverStepper = null;
    this.hoverEye = null;
    this.hoverSwitch = null;
    this.dirty = true;
    this.frame = 0;
    this.width = 0;
    this.height = 0;
    this._geometry = null;
    this._autoRanges = new Map();

    const redraw = () => {
      this.frame = 0;
      if (this.dirty) this.render();
    };
    this.requestRender = () => {
      this.dirty = true;
      if (!this.frame) this.frame = requestAnimationFrame(redraw);
    };
    this.vp.on('viewport', this.requestRender);
    this.store.on('data', this.requestRender);
    this.panes.on('change', this.requestRender);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.vp.setWidth(rect.width);
    this.vp.setLength(this.store.length);
    this.requestRender();
  }

  /** 可见区间内自动计算每个面板的纵向范围。endDraw 可越过最新 K 线，纳入外推段。 */
  autoRange(pane, start, end, endDraw = end) {
    const bars = this.store.bars;
    if (pane.kind === 'price') {
      let hi = -Infinity, lo = Infinity;
      for (let i = start; i <= end; i++) {
        const b = bars[i];
        if (!b) continue;
        if (b.high > hi) hi = b.high;
        if (b.low < lo) lo = b.low;
      }
      // 叠加线（自动支撑/压力/通道等）也要计入纵向范围：
      // 否则线落在 K 线高低价之外时会被画到画布外，看起来像"没作用"。
      for (const o of this.panes.overlays || []) {
        if (o.hidden) continue;
        const data = this.engine.get(o.id, bars, this.store.version, o.params);
        if (!data?.lines) continue;
        for (const line of data.lines) {
          if (o.style?.visible?.[line.key] === false) continue;
          const last = Math.min(endDraw, line.values.length - 1);
          for (let i = start; i <= last; i++) {
            const v = line.values[i];
            if (!Number.isFinite(v)) continue;
            if (v > hi) hi = v;
            if (v < lo) lo = v;
          }
        }
        // 文字标记（如 MOS 的 ●顶部结构）锚在价格上下方，也要算进纵向范围，
        // 否则标记会被画到面板外面裁掉。
        for (const m of data.markers || []) {
          if (!Number.isFinite(m.price) || m.i < start || m.i > endDraw) continue;
          if (m.price > hi) hi = m.price;
          if (m.price < lo) lo = m.price;
        }
      }
      if (!Number.isFinite(hi)) return { lo: 0, hi: 1 };
      const pad = Math.max((hi - lo) * 0.08, hi * 0.001);
      return { lo: lo - pad, hi: hi + pad };
    }
    const data = this.engine.get(pane.indicator, bars, this.store.version, pane.params);
    if (!data) return { lo: 0, hi: 1 };
    if (pane.indicator === 'rsi' || pane.indicator === 'dmi') return { lo: 0, hi: 100 };
    if (pane.indicator === 'wr') return { lo: -100, hi: 0 };
    let hi = -Infinity, lo = Infinity;
    for (const line of data.lines) {
      for (let i = start; i <= end; i++) {
        const v = line.values[i];
        if (!Number.isFinite(v)) continue;
        if (v > hi) hi = v;
        if (v < lo) lo = v;
      }
    }
    if (!Number.isFinite(hi)) return { lo: 0, hi: 1 };
    if (pane.indicator === 'volume') return { lo: 0, hi: hi * 1.12 || 1 };
    if (['macd', 'obv', 'cci', 'trix'].includes(pane.indicator)) {
      lo = Math.min(lo, 0); hi = Math.max(hi, 0);
    }
    const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.01 || 1;
    return { lo: lo - pad, hi: hi + pad };
  }

  geometry() {
    const vp = this.vp;
    const bars = this.store.bars;
    const left = vp.left, right = vp.right, top = 12, timeH = 22;
    const rects = this.panes.layout(this.height, timeH, top, 6, 6);
    const start = Math.max(0, Math.min(bars.length - 1, Math.floor(vp.firstIndex)));
    const end = Math.max(0, Math.min(bars.length - 1,
      Math.ceil(vp.firstIndex + vp.plotWidth / vp.barWidth)));
    // 叠加线可向最新 K 线右侧外推（右侧留白区），绘制/价格轴上限要能越过 len-1；
    // K 线、时间轴、十字光标等仍用 end，不受影响。
    const endDraw = Math.max(0, Math.min(bars.length + 64,
      Math.ceil(vp.firstIndex + vp.plotWidth / vp.barWidth)));
    const indexToX = i => vp.indexToX(i);
    const xToIndex = x => vp.xToIndex(x);

    const paneGeoms = this.panes.panes.map((pane, i) => {
      const rect = rects[i];
      const auto = this.autoRange(pane, start, end, endDraw);
      const range = pane.scale.apply(auto.lo, auto.hi);
      this._autoRanges.set(pane.id, { ...auto, height: rect.height });
      const h = Math.max(1, rect.height);
      // 伦敦金/银没有成交量：数量全 0 时不画刻度/柱，只留一行说明
      const empty = pane.indicator === 'volume'
        && !bars.slice(start, end + 1).some(b => (b.volume || 0) > 0);
      return {
        ...pane, ...rect,
        autoLo: auto.lo, autoHi: auto.hi,
        lo: range.lo, hi: range.hi,
        empty,
        titleRect: { x: left, y: rect.top, w: Math.min(230, vp.plotWidth * 0.4), h: 20 },
        separatorY: i < this.panes.panes.length - 1 ? rect.bottom : null,
        priceToY: p => rect.top + ((range.hi - p) / (range.hi - range.lo)) * h,
        yToPrice: y => range.hi - ((y - rect.top) / h) * (range.hi - range.lo),
        data: pane.kind === 'indicator'
          ? this.engine.get(pane.indicator, bars, this.store.version, pane.params) : null,
      };
    });

    const main = paneGeoms[0];

    // 多品种对比：按 ts 对齐，统一换算为相对各自首根的涨跌幅（%）
    let compareGeom = null;
    const cmp = this.compare;
    if (cmp?.symbol && cmp.bars?.length && bars.length) {
      const base = cmp.bars[0].close || 1;
      const map = new Map(cmp.bars.map(b => [b.ts, b.close]));
      const values = bars.map(b => {
        const v = map.get(b.ts);
        return Number.isFinite(v) ? (v / base - 1) * 100 : NaN;
      });
      let lo = Infinity, hi = -Infinity;
      for (let i = start; i <= end; i++) {
        const v = values[i];
        if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      }
      if (Number.isFinite(lo)) {
        const pad = Math.max((hi - lo) * 0.1, 0.05);
        lo -= pad; hi += pad;
        compareGeom = {
          symbol: cmp.symbol, color: cmp.color || '#4c9aff', values, lo, hi,
          toY: v => main.top + ((hi - v) / (hi - lo)) * Math.max(1, main.height),
        };
      }
    }

    // 隐波叠加：独立纵轴，只借用主图矩形与横向索引，不改价格轴范围。
    let vixGeom = null;
    const vix = this.vix;
    // 允许隐波数组比 bars 略短（实时 tick 刚 append 新 bar 时重算还没跟上），
    // 缺的那几根按 NaN 跳过即可；差异过大说明是旧合约残留，不画。
    if (vix?.values?.length && bars.length - vix.values.length >= 0
        && bars.length - vix.values.length <= 8) {
      let lo = Infinity, hi = -Infinity;
      for (let i = start; i <= end && i < vix.values.length; i++) {
        const value = vix.values[i];
        if (Number.isFinite(value)) { lo = Math.min(lo, value); hi = Math.max(hi, value); }
      }
      if (Number.isFinite(lo)) {
        const pad = Math.max((hi - lo) * 0.12, 0.4);
        lo -= pad; hi += pad;
        vixGeom = {
          values: vix.values, color: vix.color || '#b57bff', lo, hi,
          toY: value => main.top + ((hi - value) / (hi - lo)) * Math.max(1, main.height),
        };
      }
    }

    const g = {
      left, right, top, timeH, width: this.width, height: this.height,
      plotLeft: left, plotRight: this.width - right,
      timeAxisY: this.height - timeH,
      barWidth: vp.barWidth, start, end, endDraw,
      bars, period: this.store.period, symbol: this.store.symbol,
      priceDigits: Number.isFinite(this.store.digits) ? this.store.digits : (main.hi >= 1000 ? 0 : 2),
      indexToX, xToIndex,
      priceToY: main.priceToY, yToPrice: main.yToPrice,
      priceH: main.height, volTop: main.top,
      panes: paneGeoms, main,
      overlays: this.panes.overlays,
      settingsIcons: [], stepperIcons: [], eyeIcons: [], switchIcons: [],
      hoverSetting: this.hoverSetting, hoverStepper: this.hoverStepper,
      hoverEye: this.hoverEye, hoverSwitch: this.hoverSwitch,
      colors: COLORS, crosshair: this.crosshair, shapes: this.shapes, selected: this.selected,
      compare: compareGeom,
      vix: vixGeom,
      engine: this.engine, version: this.store.version,
    };
    return g;
  }

  screenToData(x, y) {
    const g = this._geometry || this.geometry();
    const pane = this.paneAtY(y) || g.main;
    return { index: g.xToIndex(x), price: pane.yToPrice(y), paneId: pane.id };
  }

  /** 绘图工具始终绑定主图价格轴，避免在副图上画出错位图形。 */
  screenToMainData(x, y) {
    const g = this._geometry || this.geometry();
    return { index: g.xToIndex(x), price: g.main.yToPrice(y) };
  }

  dataToScreen(index, price) {
    const g = this._geometry || this.geometry();
    return { x: g.indexToX(index), y: g.main.priceToY(price) };
  }

  paneAtY(y) {
    const g = this._geometry || this.geometry();
    return g.panes.find(p => y >= p.top && y <= p.bottom) || g.main;
  }

  /** 价格轴滚轮：以鼠标所在价位为锚做纵向缩放。 */
  verticalZoom(paneId, factor, y) {
    const g = this.geometry();
    const pane = g.panes.find(p => p.id === paneId) || g.main;
    const auto = this._autoRanges.get(pane.id);
    if (!auto) return;
    pane.scale.zoomAt(factor, pane.yToPrice(y), auto.lo, auto.hi);
    this.requestRender();
  }

  verticalPan(paneId, dy) {
    const g = this.geometry();
    const pane = g.panes.find(p => p.id === paneId) || g.main;
    const auto = this._autoRanges.get(pane.id);
    if (!auto) return;
    pane.scale.panByPixels(dy, pane.height, auto.lo, auto.hi);
    this.requestRender();
  }

  resetScale(paneId) {
    const pane = this.panes.get(paneId);
    if (pane) { pane.scale.reset(); this.requestRender(); }
  }

  setVix(data) { this.vix = data || null; this.requestRender(); }
  setCrosshair(point) { this.crosshair = point; this.requestRender(); }
  setShapes(shapes) { this.shapes = shapes; this.requestRender(); }
  setSelected(shape) { this.selected = shape; this.requestRender(); }

  /** 图例齿轮悬停高亮；仅在目标变化时重绘。 */
  setHoverSetting(icon) {
    const prev = this.hoverSetting;
    if (prev?.id === icon?.id && prev?.kind === icon?.kind) return;
    this.hoverSetting = icon;
    this.requestRender();
  }

  /** 支撑线步进器悬停高亮。 */
  setHoverStepper(icon) {
    const prev = this.hoverStepper;
    if (prev?.id === icon?.id) return;
    this.hoverStepper = icon;
    this.requestRender();
  }

  /** 图例小眼睛 / 副图切换按钮的悬停高亮。 */
  setHoverEye(icon) {
    const prev = this.hoverEye;
    if (prev?.id === icon?.id && prev?.kind === icon?.kind) return;
    this.hoverEye = icon;
    this.requestRender();
  }

  setHoverSwitch(icon) {
    const prev = this.hoverSwitch;
    if (prev?.id === icon?.id) return;
    this.hoverSwitch = icon;
    this.requestRender();
  }

  render() {
    this.dirty = false;
    const ctx = this.ctx;
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, this.width, this.height);
    if (!this.store.bars.length) return;
    const g = this.geometry();
    this._geometry = g;

    drawGrid(ctx, g);
    drawCandles(ctx, g);
    drawVix(ctx, g);
    drawOverlayLines(ctx, g);
    drawCompare(ctx, g);
    for (const pane of g.panes) {
      if (pane.kind === 'indicator') drawIndicatorPane(ctx, g, pane);
    }
    drawOverlays(ctx, g);
    drawLegend(ctx, g);
    drawCrosshair(ctx, g);
  }
}
