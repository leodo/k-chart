import { EventBus } from '../core/event_bus.js';
import { REGISTRY, defaultParams, defaultStyle, normalizeParams } from '../indicators/registry.js';

/** 单个面板的纵向比例尺：auto 基准 + 缩放 + 偏移，滚轮/拖拽只改这两个数。 */
export class PaneScale {
  constructor() { this.zoom = 1; this.offset = 0; }

  reset() { this.zoom = 1; this.offset = 0; }

  apply(autoLo, autoHi) {
    const base = Math.max(1e-9, autoHi - autoLo);
    const span = base / this.zoom;
    const mid = (autoLo + autoHi) / 2 + this.offset;
    return { lo: mid - span / 2, hi: mid + span / 2, span, base };
  }

  /** factor>1 放大纵向（价格跨度变小），以 price 所在屏幕位置为锚。 */
  zoomAt(factor, price, autoLo, autoHi) {
    const cur = this.apply(autoLo, autoHi);
    const t = Math.min(1, Math.max(0, (price - cur.lo) / (cur.hi - cur.lo)));
    this.zoom = Math.min(1000, Math.max(0.15, this.zoom * factor));
    const span = Math.max(1e-9, autoHi - autoLo) / this.zoom;
    this.offset = price - t * span + span / 2 - (autoLo + autoHi) / 2;
  }

  /** 拖拽价格轴：dy>0 内容下移 → 显示区间整体上移。 */
  panByPixels(dy, paneHeight, autoLo, autoHi) {
    if (!paneHeight) return;
    const span = Math.max(1e-9, autoHi - autoLo) / this.zoom;
    this.offset += (dy / paneHeight) * span;
  }
}

const makeInstance = id => ({
  id, params: defaultParams(id), style: defaultStyle(id), hidden: false,
});

const titleOf = (id, params) => REGISTRY[id]?.title(params) || REGISTRY[id]?.short || id;

/**
 * 面板集合：主图（价格）+ 若干副图（指标）+ 主图叠加指标。
 * 所有实例各自持有 params/style，互不干扰；新增指标无需改渲染器。
 */
export class PaneModel extends EventBus {
  constructor() {
    super();
    this.maxPanes = 4;
    this.seq = 1;
    this.panes = [{
      id: 'main', kind: 'price', indicator: null, title: '价格',
      weight: 2.4, scale: new PaneScale(), params: {}, style: null,
    }, {
      id: 'sub1', kind: 'indicator', indicator: 'volume',
      title: titleOf('volume', defaultParams('volume')),
      weight: 1, scale: new PaneScale(),
      params: defaultParams('volume'), style: defaultStyle('volume'),
    }];
    this.overlays = [makeInstance('ma')];
  }

  get length() { return this.panes.length; }
  get(id) { return this.panes.find(p => p.id === id) || null; }
  get main() { return this.panes[0]; }

  add(indicator) {
    if (this.panes.length >= this.maxPanes) return null;
    if (!REGISTRY[indicator]) return null;
    const params = defaultParams(indicator);
    const pane = {
      id: `sub${++this.seq}`, kind: 'indicator', indicator,
      title: titleOf(indicator, params), weight: 1, scale: new PaneScale(),
      params, style: defaultStyle(indicator),
    };
    this.panes.push(pane);
    this.emit('change');
    return pane;
  }

  remove(id) {
    if (id === 'main') return false;
    const i = this.panes.findIndex(p => p.id === id);
    if (i < 0) return false;
    this.panes.splice(i, 1);
    this.emit('change');
    return true;
  }

  setIndicator(id, indicator) {
    const pane = this.get(id);
    if (!pane || pane.kind !== 'indicator' || !REGISTRY[indicator]) return false;
    pane.indicator = indicator;
    pane.params = defaultParams(indicator);
    pane.style = defaultStyle(indicator);
    pane.title = titleOf(indicator, pane.params);
    pane.scale.reset();
    this.emit('change');
    return true;
  }

  /** 更新某面板的指标参数：归一化、刷新标题（图例自动显示新周期）。 */
  setParams(id, params) {
    const pane = this.get(id);
    if (!pane || pane.kind !== 'indicator') return false;
    pane.params = normalizeParams(pane.indicator, params);
    pane.title = titleOf(pane.indicator, pane.params);
    this.emit('change');
    return true;
  }

  setStyle(id, style) {
    const pane = this.get(id);
    if (!pane || pane.kind !== 'indicator') return false;
    pane.style = { ...pane.style, ...style };
    this.emit('change');
    return true;
  }

  addOverlay(name) {
    if (!REGISTRY[name] || this.getOverlay(name)) return null;
    const o = makeInstance(name);
    this.overlays.push(o);
    this.emit('change');
    return o;
  }

  removeOverlay(name) {
    const i = this.overlays.findIndex(o => o.id === name);
    if (i < 0) return false;
    this.overlays.splice(i, 1);
    this.emit('change');
    return true;
  }

  toggleOverlay(name) {
    if (this.getOverlay(name)) { this.removeOverlay(name); return false; }
    return !!this.addOverlay(name);
  }

  getOverlay(id) { return this.overlays.find(o => o.id === id) || null; }
  hasOverlay(name) { return this.overlays.some(o => o.id === name); }

  /** 图例小眼睛：隐藏时不参与计算范围、不画线和标记，但保留实例与设置。 */
  toggleOverlayHidden(id) {
    const o = this.getOverlay(id);
    if (!o) return null;
    o.hidden = !o.hidden;
    this.emit('change');
    return o.hidden;
  }

  setOverlayParams(id, params) {
    const o = this.getOverlay(id);
    if (!o) return false;
    o.params = normalizeParams(id, params);
    this.emit('change');
    return true;
  }

  setOverlayStyle(id, style) {
    const o = this.getOverlay(id);
    if (!o) return false;
    o.style = { ...o.style, ...style };
    this.emit('change');
    return true;
  }

  /** 从持久化布局整体恢复面板与叠加实例。 */
  load(config) {
    if (!config) return;
    const panes = Array.isArray(config.panes) ? config.panes.filter(p => p && REGISTRY[p.indicator] || p?.kind === 'price') : [];
    if (!panes.length || panes[0].kind !== 'price') return;
    this.panes = panes.map(p => ({
      id: p.id || 'main', kind: p.kind, indicator: p.indicator || null,
      title: p.kind === 'price' ? '价格' : titleOf(p.indicator, normalizeParams(p.indicator, p.params)),
      weight: Number(p.weight) > 0 ? Number(p.weight) : 1,
      scale: new PaneScale(),
      params: p.kind === 'price' ? {} : normalizeParams(p.indicator, p.params),
      style: p.kind === 'price' ? null : { ...defaultStyle(p.indicator), ...(p.style || {}) },
    }));
    this.overlays = (Array.isArray(config.overlays) ? config.overlays : [])
      .filter(o => o && REGISTRY[o.id])
      .map(o => ({
        id: o.id,
        hidden: !!o.hidden,
        params: normalizeParams(o.id, o.params),
        style: { ...defaultStyle(o.id), ...(o.style || {}) },
      }));
    this.seq = this.panes.reduce((m, p) => Math.max(m, Number(String(p.id).replace('sub', '')) || 0), 1);
    this.emit('change');
  }

  /** 拖拽分隔线调整相邻两个面板的高度；保持两者权重和不变，其他面板不受影响。 */
  resizePair(id1, id2, dy, h1, h2) {
    const p1 = this.get(id1), p2 = this.get(id2);
    if (!p1 || !p2 || h1 <= 0 || h2 <= 0) return;
    const totalH = h1 + h2;
    const newH1 = Math.max(48, Math.min(totalH - 48, h1 + dy));
    const totalW = p1.weight + p2.weight;
    p1.weight = totalW * (newH1 / totalH);
    p2.weight = totalW * (1 - newH1 / totalH);
    this.emit('change');
  }

  /** 按权重分配面板矩形；主图始终占更大空间。 */
  layout(height, timeH, topPad = 12, bottomPad = 6, gap = 6) {
    const usable = Math.max(60, height - timeH - topPad - bottomPad - gap * (this.panes.length - 1));
    const totalWeight = this.panes.reduce((s, p) => s + p.weight, 0);
    let y = topPad;
    return this.panes.map(p => {
      const h = (p.weight / totalWeight) * usable;
      const rect = { id: p.id, top: y, height: h, bottom: y + h };
      y += h + gap;
      return rect;
    });
  }
}
