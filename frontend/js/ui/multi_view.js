import { Chart } from '../chart/chart.js';
import { api } from '../data/api.js';
import { Feed } from '../data/feed.js';
import { persistence } from '../core/persistence.js';

/** 四宫格默认周期：左上 30 分、左下 60 分、右上日线、右下周线。 */
export const MV_CELL_DEFS = [
  { id: 'tl', label: '左上', period: '30m' },
  { id: 'bl', label: '左下', period: '1h' },
  { id: 'tr', label: '右上', period: '1d' },
  { id: 'br', label: '右下', period: '1w' },
];

export const MV_PERIODS = [
  ['1m', '1分'], ['5m', '5分'], ['15m', '15分'], ['30m', '30分'],
  ['1h', '60分'], ['4h', '4时'], ['1d', '日线'], ['1w', '周线'],
];

// 大周期不需要 1500 根，少取一些可明显减少首次进入四视图的等待。
const PERIOD_LIMIT = { '1d': 1000, '1w': 500 };

/**
 * 四视图容器：四张完全独立的 Chart（各自的数据、视口、指标、绘图与实时订阅）。
 * 每格周期独立保存，切换合约/刷新页面都从 localStorage 恢复。
 */
export class MultiView {
  constructor(options) {
    this.o = options;
    this.root = options.root;
    this.cells = {};
    this.enabled = false;
    this.opened = false;
    this.symbol = '';
    this.activeId = 'tl';
    this.saveTimer = 0;
    this.buildDom();
  }

  buildDom() {
    this.root.replaceChildren();
    for (const def of MV_CELL_DEFS) {
      const el = document.createElement('div');
      el.className = 'mv-cell';
      el.dataset.cell = def.id;

      const head = document.createElement('div');
      head.className = 'mv-head';
      const label = document.createElement('span');
      label.className = 'mv-label';
      label.textContent = def.label;
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', `${def.label}周期`);
      for (const [value, text] of MV_PERIODS) sel.appendChild(new Option(text, value));
      sel.value = def.period;
      head.append(label, sel);

      const canvas = document.createElement('canvas');
      el.append(head, canvas);
      this.root.appendChild(el);

      const cell = { ...def, el, sel, canvas, chart: null, feed: null, loadToken: 0, pendingLayout: null };
      this.cells[def.id] = cell;
      sel.addEventListener('change', () => this.setPeriod(def.id, sel.value));
      // 捕获阶段先标记激活格，保证随后 Controller 的指针事件作用在正确的图上。
      el.addEventListener('pointerdown', () => this.activate(def.id), true);
    }
  }

  allCharts() {
    return Object.values(this.cells).map(c => c.chart).filter(Boolean);
  }

  activeChart() {
    return this.enabled ? (this.cells[this.activeId]?.chart || null) : null;
  }

  activeCanvas() {
    return this.enabled ? (this.cells[this.activeId]?.canvas || null) : null;
  }

  makeFeed(cell) {
    return new Feed(
      msg => {
        cell.chart?.tick(msg.bar);
        this.o.onQuote?.(msg.quote);
      },
      (text, error) => this.o.onStatus?.(text, error),
      bars => cell.chart?.mergeBars(bars)
    );
  }

  ensureCharts() {
    for (const cell of Object.values(this.cells)) {
      if (!cell.chart) {
        cell.chart = new Chart(cell.canvas);
        this.o.onRegisterChart?.(cell.chart);
      }
      if (!cell.feed || cell.feed.closed) cell.feed = this.makeFeed(cell);
    }
  }

  restoreState(state) {
    state = state || {};
    this.enabled = !!state.enabled;
    const periods = state.periods || {};
    for (const def of MV_CELL_DEFS) {
      const cell = this.cells[def.id];
      const p = periods[def.id];
      if (p && MV_PERIODS.some(([v]) => v === p)) cell.period = p;
      cell.sel.value = cell.period;
      cell.pendingLayout = state.layouts?.[def.id] || null;
    }
    if (state.active && this.cells[state.active]) this.activeId = state.active;
  }

  saveState() {
    clearTimeout(this.saveTimer);
    const periods = {}, layouts = {};
    for (const def of MV_CELL_DEFS) {
      const cell = this.cells[def.id];
      periods[def.id] = cell.period;
      if (cell.chart) layouts[def.id] = cell.chart.captureLayout();
    }
    persistence.set('multiview', {
      enabled: this.enabled, periods, active: this.activeId, layouts,
    });
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveState(), 250);
  }

  activate(id) {
    const cell = this.cells[id];
    if (!cell || !this.enabled) return;
    this.activeId = id;
    for (const c of Object.values(this.cells)) c.el.classList.toggle('active', c.id === id);
    this.o.onActivate?.(id, cell.chart);
    this.scheduleSave();
  }

  async open(symbol) {
    if (this.enabled && this.opened) return;
    this.enabled = true;
    this.opened = true;
    this.symbol = symbol || this.symbol;
    document.getElementById('chart').classList.add('multi-mode');
    this.root.hidden = false;
    this.ensureCharts();  // 先显示再建图，ResizeObserver 才能拿到正确尺寸
    this.activate(this.activeId);
    for (const cell of Object.values(this.cells)) cell.feed.connect();
    await Promise.all(Object.values(this.cells).map(c => this.loadCell(c, this.symbol)));
    this.saveState();
  }

  close() {
    if (!this.enabled) return;
    this.enabled = false;
    this.opened = false;
    for (const cell of Object.values(this.cells)) {
      cell.feed?.close();
      cell.el.classList.remove('active');
    }
    document.getElementById('chart').classList.remove('multi-mode');
    this.root.hidden = true;
    this.saveState();
  }

  async toggle(symbol) {
    if (this.enabled) this.close();
    else await this.open(symbol);
    return this.enabled;
  }

  async loadCell(cell, symbol, { keepView = false } = {}) {
    const token = ++cell.loadToken;
    // 先切换订阅再取历史数据：否则旧合约的 tick 会在请求期间混进新数据里。
    cell.feed?.subscribe(symbol, cell.period);
    const anchor = keepView && cell.chart?.store.length
      ? this.o.captureAnchor?.(cell.chart, cell.period) : null;
    this.o.onStatus?.('加载中…');
    try {
      const data = await api.bars(symbol, cell.period, PERIOD_LIMIT[cell.period] || 1500);
      if (token !== cell.loadToken || !this.enabled) return;
      this.o.withRestore?.(() => {
        cell.chart.setData(data.bars, { symbol: data.symbol, period: data.period });
        if (cell.pendingLayout) {
          cell.chart.loadLayout(cell.pendingLayout);
          cell.pendingLayout = null;
        } else if (!this.o.restoreAnchor?.(cell.chart, anchor)) {
          if (window.matchMedia('(max-width: 760px)').matches) cell.chart.fitRecent(160);
          else cell.chart.fitToEnd(cell.chart.store.length);
        }
      });
      this.o.onStatus?.(`${cell.period} · ${data.bars.length} 根`);
    } catch (err) {
      if (token !== cell.loadToken) return;
      this.o.onStatus?.(String(err.message || err), true);
    }
  }

  async setPeriod(id, period) {
    const cell = this.cells[id];
    if (!cell || !MV_PERIODS.some(([v]) => v === period)) return;
    cell.period = period;
    cell.sel.value = period;
    this.o.onPeriodChanged?.(id, period);
    this.scheduleSave();
    if (this.enabled && this.symbol) await this.loadCell(cell, this.symbol, { keepView: true });
  }

  async reload(symbol) {
    if (!this.enabled) return;
    this.symbol = symbol;
    for (const cell of Object.values(this.cells)) {
      await this.loadCell(cell, symbol, { keepView: true });
    }
    this.saveState();
  }
}
