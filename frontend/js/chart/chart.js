import { BarStore } from '../core/store.js';
import { Viewport } from '../core/viewport.js';
import { PaneModel } from './panes.js';
import { Renderer } from './renderer.js';
import { ToolManager } from '../tools/tool_manager.js';
import { InteractionController } from '../interaction/controller.js';

/** 图表门面：组合数据、视口、面板、渲染、交互、工具，对外只暴露少量方法。 */
export class Chart {
  constructor(canvas) {
    this.store = new BarStore();
    this.vp = new Viewport();
    this.panes = new PaneModel();
    this.renderer = new Renderer(canvas, this.store, this.vp, this.panes);
    this.tools = new ToolManager(this.renderer);
    this.compare = { symbol: '', bars: [], color: '#4c9aff' };
    this.renderer.compare = this.compare;
    this.controller = new InteractionController(
      canvas, this.vp, this.renderer, this.panes, this.tools,
      () => this.store.length,
      (paneId, x, y) => this.onPaneMenu?.(paneId, x, y),
      (icon, x, y) => this.onIndicatorSettings?.(icon, x, y),
      (id, delta) => this.onSupportStep?.(id, delta),
      eye => this.onEyeToggle?.(eye),
      (icon, x, y) => this.onPaneSwitch?.(icon, x, y)
    );

    this.store.on('data', ({ reason }) => {
      if (this.vp.length !== this.store.length) this.vp.setLength(this.store.length);
      if (reason === 'reset') this.vp.fitAll(this.store.length);
      this.renderer.requestRender();
    });

    new ResizeObserver(() => this.renderer.resize()).observe(canvas);
    this.renderer.resize();
  }

  setData(bars, meta) { this.store.setBars(bars, meta); }
  tick(bar) { this.store.upsert(bar); }
  mergeBars(bars) { this.store.mergeBars(bars); }

  fit() { this.vp.fitToEnd(this.store.length); }
  fitAll() { this.vp.fitAll(this.store.length); }
  fitRecent(count) { this.vp.fitRecent(count); }

  addPane(indicator) { return this.panes.add(indicator); }
  removePane(id) { return this.panes.remove(id); }
  setPaneIndicator(id, indicator) { return this.panes.setIndicator(id, indicator); }
  setPaneParams(id, params) { return this.panes.setParams(id, params); }
  setPaneStyle(id, style) { return this.panes.setStyle(id, style); }
  addOverlay(id) { return this.panes.addOverlay(id); }
  removeOverlay(id) { return this.panes.removeOverlay(id); }
  toggleOverlayHidden(id) { return this.panes.toggleOverlayHidden(id); }
  setOverlayParams(id, params) { return this.panes.setOverlayParams(id, params); }
  setOverlayStyle(id, style) { return this.panes.setOverlayStyle(id, style); }

  /** 支撑线步进：+ 往前纳入更早的一条，− 收掉最早的一条。返回最新 count。 */
  stepSupport(id, delta) {
    const o = this.panes.getOverlay(id);
    if (!o) return 0;
    const cur = Math.round(Number(o.params?.count) || 0);
    const next = Math.max(0, Math.min(12, cur + delta));
    if (next === cur) return cur;
    this.panes.setOverlayParams(id, { ...o.params, count: next });
    return next;
  }
  resizePair(id1, id2, dy, h1, h2) { this.panes.resizePair(id1, id2, dy, h1, h2); }
  resetScale(paneId) { this.renderer.resetScale(paneId); }

  setCompare(symbol, bars) {
    this.compare.symbol = symbol || '';
    this.compare.bars = bars || [];
    this.renderer.requestRender();
  }

  setVix(data) { this.renderer.setVix(data); }

  setTool(name) { return this.tools.setActive(name); }
  clearTools() { this.tools.clear(); }

  loadLayout(layout) {
    if (!layout) return;
    this.panes.load(layout);
    this.tools.load(layout.shapes);
    const vp = layout.viewport || {};
    if (Number.isFinite(vp.barWidth) && vp.barWidth > 0) this.vp.barWidth = Math.min(this.vp.maxBarWidth, Math.max(this.vp.minBarWidth, vp.barWidth));
    if (Number.isFinite(vp.first)) this.vp.setRawFirst(vp.first);
  }

  captureLayout() {
    return {
      panes: this.panes.panes.map(p => ({
        id: p.id, kind: p.kind, indicator: p.indicator,
        params: p.params, style: p.style, weight: p.weight,
      })),
      overlays: this.panes.overlays.map(o => ({ id: o.id, params: o.params, style: o.style, hidden: !!o.hidden })),
      shapes: this.tools.shapes,
      viewport: { barWidth: this.vp.barWidth, first: this.vp._first },
    };
  }
}
