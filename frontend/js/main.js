import { Chart } from './chart/chart.js';
import { api } from './data/api.js';
import { alignVix } from './data/vix.js';
import { Feed } from './data/feed.js';
import { Controls } from './ui/controls.js';
import { IndicatorSettings } from './ui/indicator_settings.js';
import { bindMenu } from './ui/menu.js';
import { CommandPalette } from './ui/command_palette.js';
import { AlertManager, notify } from './core/alerts.js';
import { persistence } from './core/persistence.js';
import { PANE_OPTIONS, OVERLAY_OPTIONS, REGISTRY } from './indicators/registry.js';
import { DRAW_TOOLS } from './tools/tool_manager.js';
import { MultiView } from './ui/multi_view.js';

const PERIOD_LIST = [
  ['1m', '1 分钟'], ['5m', '5 分钟'], ['15m', '15 分钟'], ['30m', '30 分钟'],
  ['1h', '1 小时'], ['4h', '4 小时'], ['1d', '日线'], ['1w', '周线'],
];
const PERIOD_MINUTES = {
  '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440, '1w': 10080,
};
const TOOL_LABELS = {
  select: '选择 / 移动', trendline: '趋势线', ray: '射线', horizontal: '水平线',
  vertical: '垂直线', rect: '矩形', fib: '斐波那契回撤', measure: '测量', text: '文字',
};
const SHAPE_LABELS = TOOL_LABELS;

const canvas = document.getElementById('canvas');
const nineBtn = document.getElementById('nine-toggle');
const singleChart = new Chart(canvas);
const allCharts = new Set([singleChart]);
const chartCallbacks = {};
/** 这些操作对全部视图同时生效，其余（缩放/绘图/指标设置等）只作用于当前激活视图。 */
const BROADCAST_METHODS = new Set(['setCompare', 'setTool', 'clearTools']);
let multiView = null;

/** 每张 Chart 都要接一遍会话保存与浮层回调，四视图是四张独立实例。 */
function registerChart(c) {
  allCharts.add(c);
  for (const [key, fn] of Object.entries(chartCallbacks)) c[key] = fn;
  c.vp.on('viewport', scheduleSessionSave);
  c.panes.on('change', scheduleSessionSave);
  c.tools.onChange = scheduleSessionSave;
  c.tools.onSelectionChange = shape => handleShapeSelection(c, shape);
  // 数据变化后重算隐波对齐：
  // - reset（换合约/周期）：先按新合约取序列；
  // - append/update（实时 tick 往尾部加 bar）：也要重新对齐，否则 bars 比隐波数组多一根，
  //   渲染层因长度不等永久跳过绘制，表现为「切品种后某格隐波突然消失」。
  c.store.on('data', ({ reason }) => {
    if (!vixEnabled) { c.setVix(null); return; }
    if (reason === 'reset') ensureVixForSymbol(c.store.symbol, c.store.period);
    else if (reason === 'append' || reason === 'update') applyVixOverlay();
  });
}
registerChart(singleChart);

/** 把全站对 chart 的调用动态指向「普通视图」或「四视图当前格」。 */
const chart = new Proxy({}, {
  get(_, prop) {
    const target = multiView?.activeChart() || singleChart;
    const value = target[prop];
    if (typeof value !== 'function') return value;
    if (BROADCAST_METHODS.has(prop)) return (...args) => {
      let result;
      for (const c of allCharts) {
        const r = c[prop](...args);
        if (r !== undefined) result = r;
      }
      return result;
    };
    return value.bind(target);
  },
  set(_, prop, value) {
    chartCallbacks[prop] = value;
    for (const c of allCharts) c[prop] = value;
    return true;
  },
});

const state = { symbol: 'RBL9', period: '5m' };
let loadToken = 0;
let symbolsCache = [];
let compareData = null;
let pendingViewport = null;
/** key = `${symbol}|${period}`，日线/周线共用日线序列，日内按周期单独缓存实算序列。 */
const vixCache = new Map();
let vixEnabled = false;

/* ---------- 指标设置（参数 / 样式） ---------- */
const settings = new IndicatorSettings({
  onApply: ({ kind, id, params, style }) => {
    if (kind === 'pane') {
      chart.setPaneParams(id, params);
      chart.setPaneStyle(id, style);
    } else {
      chart.setOverlayParams(id, params);
      chart.setOverlayStyle(id, style);
    }
  },
  onDelete: (ctx) => {
    if (!ctx) return;
    if (ctx.kind === 'overlay') chart.removeOverlay(ctx.id);
    else { chart.removePane(ctx.id); controls.setPaneCount(chart.panes.length); }
  },
});
/**
 * 打开设置时带入实例当前的 params/style。
 * 否则表单总显示默认值，点「确定」会把已勾选的支撑/压力、已调好的延长根数全部重置。
 */
function openSettings(ctx) {
  const inst = ctx.kind === 'pane' ? chart.panes.get(ctx.id) : chart.panes.getOverlay(ctx.id);
  settings.open({ ...ctx, params: inst?.params, style: inst?.style });
}

chart.onIndicatorSettings = (icon, x, y) => {
  closePaneMenu();
  openSettings({ kind: icon.kind, id: icon.id, indicator: icon.indicator, x, y });
};

/** 图例小眼睛：隐藏主图叠加指标（线、标记与图例数值一起收起）。 */
chart.onEyeToggle = (icon) => {
  if (icon?.kind !== 'overlay') return;
  const hidden = chart.toggleOverlayHidden(icon.id);
  closePaneMenu();
  refreshMenus();
  scheduleSessionSave();
  controls.setStatus(`${REGISTRY[icon.id]?.short || icon.id} 已${hidden ? '隐藏' : '显示'}`);
};

/** 副图标题的切换按钮：直接选另一个指标替换当前副图。 */
const paneSwitchMenu = bindMenu(
  document.getElementById('pane-switch-anchor'), document.getElementById('pane-switch-menu'), [], item => {
    if (!item.paneId) return;
    if (chart.setPaneIndicator(item.paneId, item.value)) {
      controls.setPaneCount(chart.panes.length);
      refreshMenus();
      scheduleSessionSave();
      controls.setStatus(`副图已切换为 ${REGISTRY[item.value]?.short || item.value}`);
    }
  }
);
chart.onPaneSwitch = (icon, x, y) => {
  const pane = chart.panes.get(icon?.id);
  paneSwitchMenu.setItems(PANE_OPTIONS.map(id => ({
    label: `${pane?.indicator === id ? '✓ ' : ''}${REGISTRY[id].short} · ${REGISTRY[id].name}`,
    value: id, paneId: icon.id, active: pane?.indicator === id,
  })));
  // 延后到本次 pointerdown 冒泡结束再显示，避免 bindMenu 的「点外部关闭」把刚开的菜单关掉。
  setTimeout(() => paneSwitchMenu.openAt(x, y), 0);
};

/* ---------- 支撑线步进：+ 往历史方向纳入下一条，− 收掉最早的一条 ---------- */
chart.onSupportStep = (id, delta) => {
  const next = chart.stepSupport(id, delta);
  controls.setStatus(`支撑线 ${next} 组${next ? '（最近优先；+ 往前追溯，− 先收最早的）' : '（已隐藏）'}`);
  scheduleSessionSave();
};

function stepSupportAfterEnsure(delta) {
  let o = chart.panes.getOverlay('channel');
  if (!o) {
    o = chart.addOverlay('channel');
    refreshMenus();
  }
  if (!o) return;
  const next = chart.stepSupport(o.id, delta);
  controls.setStatus(`支撑线 ${next} 组${next ? '（最近优先；+ 往前追溯，− 先收最早的）' : '（已隐藏）'}`);
  scheduleSessionSave();
}
document.getElementById('support-inc').addEventListener('click', () => stepSupportAfterEnsure(1));
document.getElementById('support-dec').addEventListener('click', () => stepSupportAfterEnsure(-1));

/** 顶部周期按钮：普通视图改全局周期，四视图改当前激活格。 */
function applyPeriod(period) {
  if (multiView?.enabled) multiView.setPeriod(multiView.activeId, period);
  else { state.period = period; saveLayout(false); load({ keepView: true }); }
}

const controls = new Controls({
  onSymbol: (symbol) => {
    state.symbol = symbol;
    saveLayout(false);
    if (multiView?.enabled) multiView.reload(symbol);
    else load({ keepView: true });
  },
  onPeriod: (period) => applyPeriod(period),
  onLatest: () => chart.fit(),
  onFitAll: () => chart.fitAll(),
  onAddPane: (id) => {
    if (chart.addPane(id)) controls.setPaneCount(chart.panes.length);
  },
  onDelPane: () => {
    const subs = chart.panes.panes.filter(p => p.kind === 'indicator');
    if (subs.length) chart.removePane(subs[subs.length - 1].id);
    controls.setPaneCount(chart.panes.length);
  },
});

/* ---------- 四视图 ---------- */
multiView = new MultiView({
  root: document.getElementById('multi-chart'),
  onStatus: (text, error) => controls.setStatus(text, error),
  onRegisterChart: c => registerChart(c),
  onActivate: (id, c) => {
    controls.setPaneCount(c?.panes.length ?? 1);
    refreshMenus();
  },
  onPeriodChanged: (id, period) => controls.setPeriod(period),
  captureAnchor: (c, targetPeriod) => captureViewAnchor(c, targetPeriod),
  restoreAnchor: (c, anchor) => restoreViewAnchor(c, anchor),
  withRestore: fn => withRestore(fn),
  onQuote: q => {
    controls.setQuote(q);
    alerts.check(q?.symbol || state.symbol, q?.price);
  },
});

const mvButton = document.getElementById('multiview');
mvButton.addEventListener('click', async () => {
  mvButton.disabled = true;
  try {
    await multiView.toggle(state.symbol);
    mvButton.classList.toggle('active', multiView.enabled);
    mvButton.title = multiView.enabled
      ? '四视图：再点一次还原为普通界面'
      : '四视图：30分 / 60分 / 日线 / 周线（再点一次还原）';
    if (multiView.enabled) {
      controls.setStatus('四视图 · 点各格右上角切换周期（设置会记住）');
    } else {
      // 四视图里顶栏周期高亮跟着当前格走；还原后要重新对齐主图的周期。
      controls.setPeriod(state.period);
      controls.setPaneCount(chart.panes.length);
      refreshMenus();
      // 四视图期间可能换过合约，单图的数据还停留在进入前，需要同步一次。
      await load({ keepView: true });
      controls.setStatus('已还原为普通界面');
    }
  } catch (err) {
    controls.setStatus(String(err.message || err), true);
  } finally {
    mvButton.disabled = false;
  }
});

/* ---------- 副图标题菜单 ---------- */
const paneMenu = document.getElementById('pane-menu');
const paneMenuIndicator = document.getElementById('pane-menu-indicator');
let menuPaneId = null;
for (const id of PANE_OPTIONS) paneMenuIndicator.appendChild(new Option(REGISTRY[id].short, id));

function closePaneMenu() { paneMenu.hidden = true; menuPaneId = null; }

function handlePaneMenu(paneId, clientX, clientY) {
  if (!paneId) { closePaneMenu(); return; }
  const pane = chart.panes.get(paneId);
  if (!pane || pane.kind !== 'indicator') return;
  menuPaneId = paneId;
  paneMenuIndicator.value = pane.indicator;
  const chartRect = document.getElementById('chart').getBoundingClientRect();
  paneMenu.hidden = false;
  paneMenu.style.left = `${Math.max(4, Math.min(clientX - chartRect.left, chartRect.width - paneMenu.offsetWidth - 4))}px`;
  paneMenu.style.top = `${Math.max(4, Math.min(clientY - chartRect.top, chartRect.height - paneMenu.offsetHeight - 4))}px`;
}
chart.onPaneMenu = handlePaneMenu;

paneMenuIndicator.addEventListener('change', () => {
  if (!menuPaneId) return;
  chart.setPaneIndicator(menuPaneId, paneMenuIndicator.value);
  closePaneMenu();
});
document.getElementById('pane-menu-settings').addEventListener('click', () => {
  if (!menuPaneId) return;
  const pane = chart.panes.get(menuPaneId);
  if (!pane) return;
  const rect = paneMenu.getBoundingClientRect();
  openSettings({ kind: 'pane', id: menuPaneId, indicator: pane.indicator, x: rect.left, y: rect.top });
  closePaneMenu();
});
document.getElementById('pane-menu-reset').addEventListener('click', () => {
  if (menuPaneId) chart.resetScale(menuPaneId);
  closePaneMenu();
});
document.getElementById('pane-menu-delete').addEventListener('click', () => {
  if (menuPaneId && chart.removePane(menuPaneId)) controls.setPaneCount(chart.panes.length);
  closePaneMenu();
});
document.getElementById('pane-menu-close').addEventListener('click', closePaneMenu);

/* ---------- 叠加 / 工具菜单 ---------- */
const overlayMenu = bindMenu(
  document.getElementById('overlay'), document.getElementById('overlay-menu'), [], item => {
    let o = chart.panes.getOverlay(item.value);
    if (!o) o = chart.addOverlay(item.value);
    if (!o) return;
    const rect = document.getElementById('overlay-menu').getBoundingClientRect();
    openSettings({ kind: 'overlay', id: o.id, indicator: o.id, x: rect.left, y: rect.top });
    refreshMenus();
  }
);

/* ---------- 自动线：支撑 / 压力 / 通道 ---------- */
function ensureChannel(patch = {}) {
  let o = chart.panes.getOverlay('channel');
  if (!o) o = chart.addOverlay('channel');
  if (!o) return null;
  const params = { ...o.params, ...patch };
  params.count = Math.max(1, Math.min(12, Math.round(Number(params.count) || 0) || 1));
  chart.setOverlayParams(o.id, params);
  refreshMenus();
  scheduleSessionSave();
  return o;
}

/** 只读：自动线是否有任意一段落在当前视口内。绝不改动视口/焦点。 */
function autoLinesInView(o) {
  const vp = chart.vp, bars = chart.store.bars;
  if (!bars.length) return true;
  const data = chart.renderer.engine.get('channel', bars, chart.store.version, o.params);
  const from = Math.max(0, Math.floor(vp.firstIndex));
  const to = Math.min(bars.length + 64, Math.ceil(vp.firstIndex + vp.visibleCount));
  for (const line of data?.lines || []) {
    if (line.values.length <= from) continue;
    for (let i = from; i <= Math.min(to, line.values.length - 1); i++) {
      if (Number.isFinite(line.values[i])) return true;
    }
  }
  return false;
}

function setAutoLine(side) {
  // 「按形态」与「指定方向」二选一：drop 到具体方向时关掉 trend，回到自动时清掉方向。
  const o = ensureChannel({ side, trend: side === 0 ? 1 : 0 });
  if (!o) return;
  const label = side === 1 ? '支撑线' : side === 2 ? '压力线'
    : side === 3 ? '支撑 + 压力线' : '通道 / 趋势线';
  // 自动线始终基于最近行情绘制，切换模式不转移焦点；
  // 若用户正停留在历史区域，只给提示，由他自己决定要不要点「最新」。
  controls.setStatus(autoLinesInView(o)
    ? `已启用自动${label}（基于最近行情）；图例 ± 可增减`
    : `已启用自动${label}（画在最近行情）；点「最新」查看`);
}

const autoLinesMenu = bindMenu(
  document.getElementById('auto-lines'), document.getElementById('auto-lines-menu'), [], item => {
    const v = item.value;
    const o = chart.panes.getOverlay('channel');
    if (v === 'auto') {
      // 全不勾选 = 一条都不画；再点一下恢复「按形态自动画」。
      const on = Number(o?.params?.trend ?? 1) !== 0;
      if (on) {
        ensureChannel({ trend: 0 });
        controls.setStatus('已关闭自动趋势线（勾选的支撑/压力/通道仍会画）');
      } else {
        ensureChannel({ trend: 1, side: 0 });
        controls.setStatus('已开启自动趋势线（按形态）');
      }
    } else if (v === 'toggleSupport' || v === 'toggleResistance') {
      // 位掩码 toggle：支撑与压力互不影响，可以同时勾选；
      // 明确勾选方向时自动关闭「按形态」，两个都不勾就什么都不画。
      const cur = Math.round(Number(o?.params?.side) || 0);
      const next = cur ^ (v === 'toggleSupport' ? 1 : 2);
      ensureChannel({ side: next, trend: 0 });
      const sup = (next & 1) !== 0, res = (next & 2) !== 0;
      controls.setStatus(!sup && !res
        ? '支撑 / 压力都未勾选，图上不再画线'
        : `只画${sup && res ? '支撑 + 压力' : sup ? '支撑' : '压力'}线`);
    } else if (v === 'inc') stepSupportAfterEnsure(1);
    else if (v === 'dec') stepSupportAfterEnsure(-1);
    else if (v === 'breakout') {
      const cur = Number(o?.params?.breakout ?? 1) ? 1 : 0;
      ensureChannel({ breakout: cur ? 0 : 1 });
      controls.setStatus(cur ? '已关闭「突破后重连新线」' : '已开启「突破后重连新线」');
    } else if (v === 'major') {
      const cur = Number(o?.params?.major ?? 1) ? 1 : 0;
      ensureChannel({ major: cur ? 0 : 1 });
      controls.setStatus(cur ? '已关闭「显著高低点通道」' : '已开启「显著高低点通道」');
    } else if (v === 'settings') {
      if (!o) return;
      const br = document.getElementById('auto-lines').getBoundingClientRect();
      openSettings({ kind: 'overlay', id: o.id, indicator: o.id, x: br.left, y: br.bottom });
    } else if (v === 'remove') {
      chart.removeOverlay('channel');
      refreshMenus();
      scheduleSessionSave();
      controls.setStatus('已移除自动线');
    }
  }
);

function refreshAutoLinesMenu() {
  const o = chart.panes.getOverlay('channel');
  const side = Math.round(Number(o?.params?.side) || 0);
  const count = Math.round(Number(o?.params?.count) || 0);
  const trend = Number(o?.params?.trend ?? 1) !== 0;
  const active = !!o && count > 0;
  const brk = Number(o?.params?.breakout ?? 1) !== 0;
  const mj = Number(o?.params?.major ?? 1) !== 0;
  const sup = (side & 1) !== 0, res = (side & 2) !== 0;
  const autoOn = trend && side === 0;
  autoLinesMenu.setItems([
    { label: `${autoOn ? '☑' : '☐'} 自动趋势线（按形态）`, value: 'auto', active: active && autoOn, hint: '按形态自动判断画趋势线还是通道，方向不限；与下面的支撑/压力互斥' },
    { label: `${sup ? '☑' : '☐'} 支撑线`, value: 'toggleSupport', active: sup, hint: '只画支撑方向；与压力线可同时勾选' },
    { label: `${res ? '☑' : '☐'} 压力线`, value: 'toggleResistance', active: res, hint: '只画压力方向；与支撑线可同时勾选' },
    { label: `${mj ? '☑' : '☐'} 显著高低点通道`, value: 'major', active: mj, hint: '连接大级别摆动高点/低点，画从主要顶底出发的长平行通道' },
    { label: `${brk ? '☑' : '☐'} 突破后重连新线`, value: 'breakout', active: brk, hint: '价格突破后，把新的高点/低点与前一个支点连成新线' },
    { label: `增加一组（当前 ${count} 组/类）`, value: 'inc' },
    { label: '减少一组', value: 'dec' },
    { label: '参数设置…', value: 'settings' },
    { label: '移除自动线', value: 'remove', active: !active },
  ]);
}

function selectTool(name) {
  const ok = chart.setTool(name);
  if (!ok) return;
  refreshMenus();
  controls.setStatus(name === 'select' ? '选择模式' : `工具：${TOOL_LABELS[name] || name}`);
}

const toolsMenu = bindMenu(
  document.getElementById('tools'), document.getElementById('tools-menu'), [], item => selectTool(item.value)
);
// 常驻选择按钮：画完线会自动切回选择模式，这里用于随时切回。
document.getElementById('tool-select').addEventListener('click', () => selectTool('select'));

function refreshMenus() {
  nineBtn.classList.toggle('active', chart.panes.hasOverlay('nine'));
  overlayMenu.setItems(OVERLAY_OPTIONS.map(id => ({
    label: id === 'channel' ? '自动线（支撑/压力/通道）' : REGISTRY[id].short,
    value: id, active: chart.panes.hasOverlay(id),
  })));
  refreshAutoLinesMenu();
  toolsMenu.setItems(DRAW_TOOLS.map(t => ({
    label: TOOL_LABELS[t] || t, value: t, active: chart.tools.active?.name === t,
  })));
  document.getElementById('tool-select').classList.toggle('active', chart.tools.active?.name === 'select');
}

/* ---------- 图形属性 ---------- */
const shapeProps = document.getElementById('shape-props');
function handleShapeSelection(sourceChart, shape) {
  if (!shape) { shapeProps.hidden = true; return; }
  document.getElementById('shape-props-type').textContent = SHAPE_LABELS[shape.type] || shape.type;
  document.getElementById('shape-color').value = shape.color || '#f2c14e';
  document.getElementById('shape-width').value = shape.width || 1.5;
  shapeProps.hidden = false;
  // 贴着图形放，不遮住主图左上角的图例（图例上的 CH ± 需要可点）。
  const pt = sourceChart.renderer.dataToScreen(shape.i1, shape.p1);
  const box = document.getElementById('chart').getBoundingClientRect();
  const w = shapeProps.offsetWidth, h = shapeProps.offsetHeight;
  shapeProps.style.left = `${Math.max(4, Math.min(box.width - w - 4, pt.x + 14))}px`;
  shapeProps.style.top = `${Math.max(4, Math.min(box.height - h - 4, pt.y - h - 14))}px`;
}
document.getElementById('shape-color').addEventListener('input', e => chart.tools.updateSelected({ color: e.target.value }));
document.getElementById('shape-width').addEventListener('input', e => chart.tools.updateSelected({ width: Number(e.target.value) }));
document.getElementById('shape-delete').addEventListener('click', () => chart.tools.deleteSelected());
document.getElementById('shape-props-close').addEventListener('click', () => chart.tools.select(null));

canvas.addEventListener('dblclick', e => {
  const r = canvas.getBoundingClientRect();
  const hit = chart.tools.hitTest({ x: e.clientX - r.left, y: e.clientY - r.top }, chart.renderer);
  if (hit?.shape.type !== 'text') return;
  const text = window.prompt('编辑文字', hit.shape.text || '');
  if (text != null) chart.tools.updateSelected({ text });
});

/* ---------- 价格警报 ---------- */
const alertPanel = document.getElementById('alert-panel');
const alertListEl = document.getElementById('alert-list');
const alerts = new AlertManager((a, price) => {
  const dir = a.dir === 'above' ? '上破' : '下破';
  controls.setStatus(`警报：${a.symbol} ${dir} ${a.price}（现价 ${price}）`);
  notify('价格警报', `${a.symbol} ${dir} ${a.price}，现价 ${price}`);
  renderAlerts();
  persistence.set('alerts', alerts.items);
});

function renderAlerts() {
  alertListEl.replaceChildren(...alerts.items.map(a => {
    const row = document.createElement('div');
    row.className = `alert-item${a.triggered ? ' done' : ''}`;
    const text = document.createElement('span');
    text.className = 'alert-text';
    text.textContent = `${a.symbol} ${a.dir === 'above' ? '上破' : '下破'} ${a.price}${a.triggered ? ' ✓' : ''}`;
    const toggle = document.createElement('button');
    toggle.className = 'btn';
    toggle.textContent = a.enabled ? '停' : '启';
    toggle.addEventListener('click', () => {
      alerts.toggle(a.id);
      renderAlerts();
      persistence.set('alerts', alerts.items);
    });
    const del = document.createElement('button');
    del.className = 'btn';
    del.textContent = '×';
    del.addEventListener('click', () => {
      alerts.remove(a.id);
      renderAlerts();
      persistence.set('alerts', alerts.items);
    });
    row.append(text, toggle, del);
    return row;
  }));
}

document.getElementById('alert-btn').addEventListener('click', () => {
  alertPanel.hidden = !alertPanel.hidden;
  if (!alertPanel.hidden) {
    document.getElementById('alert-symbol').value ||= state.symbol;
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  }
});
document.getElementById('alert-close').addEventListener('click', () => { alertPanel.hidden = true; });
document.getElementById('alert-add').addEventListener('click', () => {
  const item = alerts.add({
    symbol: document.getElementById('alert-symbol').value || state.symbol,
    dir: document.getElementById('alert-dir').value,
    price: document.getElementById('alert-price').value,
  });
  if (!item) { controls.setStatus('警报参数无效', true); return; }
  document.getElementById('alert-price').value = '';
  renderAlerts();
  persistence.set('alerts', alerts.items);
  controls.setStatus(`已添加 ${item.symbol} 警报`);
});

/* ---------- 多品种对比 ---------- */
const comparePanel = document.getElementById('compare-panel');
function populateCompareSymbols(symbols) {
  const el = document.getElementById('compare-symbol');
  el.replaceChildren(...symbols.map(s => new Option(`${s.name} (${s.code})`, s.code)));
  el.value = symbols.find(s => s.code === 'RBL9')?.code || symbols[0]?.code || '';
}
document.getElementById('compare-btn').addEventListener('click', () => {
  comparePanel.hidden = !comparePanel.hidden;
});
document.getElementById('compare-close').addEventListener('click', () => { comparePanel.hidden = true; });
document.getElementById('compare-enable').addEventListener('click', () => loadCompare(document.getElementById('compare-symbol').value));
document.getElementById('compare-disable').addEventListener('click', () => {
  compareData = null;
  chart.setCompare('', []);
  controls.setStatus('已关闭对比');
});

async function loadCompare(symbol) {
  if (!symbol) return;
  controls.setStatus('加载对比…');
  try {
    const data = await api.bars(symbol, state.period, 1500);
    compareData = { symbol: data.symbol, bars: data.bars };
    chart.setCompare(data.symbol, data.bars);
    comparePanel.hidden = true;
    controls.setStatus(`对比 ${data.symbol} · ${data.bars.length} 根`);
  } catch (err) {
    controls.setStatus(`对比失败: ${err.message || err}`, true);
  }
}

/* ---------- 隐波叠加（独立纵轴） ---------- */
const vixPending = new Set();
function applyVixOverlay() {
  for (const c of allCharts) {
    if (!vixEnabled) { c.setVix(null); continue; }
    // 必须按该图自己的合约+周期取序列；不能退回到全局合约，否则旧隐波会画到新图上。
    const period = c.store.period || state.period;
    const cached = vixCache.get(`${c.store.symbol}|${period}`);
    if (!cached?.series?.length) { c.setVix(null); continue; }
    const intraday = period !== '1d' && period !== '1w' ? cached.series : null;
    const values = alignVix(intraday ? null : cached.series, c.store.bars, period, intraday);
    c.setVix({ values, color: '#b57bff' });
  }
}

async function ensureVixForSymbol(symbol, period = '1d', force = false) {
  if (!symbol) return;
  const key = `${symbol}|${period}`;
  if (!force && vixCache.has(key)) { applyVixOverlay(); return; }
  if (vixPending.has(key)) return;
  vixPending.add(key);
  try {
    const data = await api.vixSeries(symbol, period);
    vixCache.set(key, data);
    applyVixOverlay();
    if (data.series?.length) {
      const label = period === '1d' ? '日线' : period;
      controls.setStatus(`隐波 ${symbol} · ${data.series.length} 根${label}（独立纵轴）`);
    }
  } catch (err) {
    controls.setStatus(`隐波加载失败: ${err.message || err}`, true);
  } finally {
    vixPending.delete(key);
  }
}
// 兼容原有调用名
const loadVixData = ensureVixForSymbol;

/** 四视图每一格的合约/周期都可能不同：逐图按其 symbol|period 加载，去重并发。 */
async function loadVixForAllCharts() {
  if (!vixEnabled) { applyVixOverlay(); return; }
  const seen = new Set();
  const jobs = [];
  const visible = multiView?.enabled ? multiView.allCharts() : [singleChart];
  for (const c of visible) {
    const symbol = c.store.symbol;
    const period = c.store.period || state.period;
    if (!symbol) continue; // 四视图刚打开、该格数据还在加载中；data(reset) 回调会补加载
    const key = `${symbol}|${period}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!vixCache.has(key) && !vixPending.has(key)) jobs.push(ensureVixForSymbol(symbol, period));
  }
  await Promise.all(jobs);
  applyVixOverlay();
  return seen;
}

async function toggleVix() {
  vixEnabled = !vixEnabled;
  document.getElementById('vix-toggle').classList.toggle('active', vixEnabled);
  if (vixEnabled) {
    controls.setStatus('加载隐波…');
    const keys = await loadVixForAllCharts();
    const list = [...(keys || [])];
    const ready = list.filter(k => vixCache.get(k)?.series?.length).length;
    if (!ready) controls.setStatus('该品种暂无隐波数据（可能没有期权）', true);
    else if (multiView?.enabled) {
      controls.setStatus(ready < list.length
        ? `隐波已叠加 ${ready}/${list.length} 个周期（其余品种可能无期权）`
        : `隐波已叠加 ${ready} 个周期（独立纵轴）`);
    } else {
      controls.setStatus(`隐波 ${state.symbol} · ${vixCache.get(list[0])?.series?.length || 0} 根（独立纵轴）`);
    }
  } else {
    applyVixOverlay();
    controls.setStatus('已关闭隐波叠加');
  }
  scheduleSessionSave();
}
document.getElementById('vix-toggle').addEventListener('click', toggleVix);

/* ---------- 神奇九转（主图数字标记） ---------- */
nineBtn.addEventListener('click', () => {
  const on = chart.panes.hasOverlay('nine');
  if (on) chart.removeOverlay('nine');
  else chart.addOverlay('nine');
  refreshMenus();
  scheduleSessionSave();
  controls.setStatus(on ? '已关闭神奇九转' : '已开启神奇九转（1~9 / 13）');
});

/* ---------- 布局与模板 ---------- */
function captureFullLayout() {
  return {
    ...chart.captureLayout(),
    symbol: state.symbol,
    period: state.period,
    vixEnabled,
    compare: { symbol: compareData?.symbol || '' },
    alerts: alerts.items,
  };
}

function saveLayout(notifyUser = true) {
  persistence.set('layout', captureFullLayout());
  if (notifyUser) controls.setStatus('布局已保存');
}

/* ---------- 会话自动保存：F5 后 K 线位置/缩放保持不变 ---------- */
// viewport 变更（拖拽/滚轮/双击）与面板比例变更都触发，防抖写入，避免频繁 IO。
let sessionTimer = 0;
let restoringSession = false;
function withRestore(fn) {
  restoringSession = true;
  try { return fn(); } finally { restoringSession = false; }
}
function persistSession() {
  if (restoringSession) return;
  persistence.set('session', captureFullLayout());
  multiView?.saveState();
}
function scheduleSessionSave() {
  if (restoringSession) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(persistSession, 250);
}
function flushSession() {
  clearTimeout(sessionTimer);
  persistSession();
}
window.addEventListener('pagehide', flushSession);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSession();
});

function refreshTemplates() {
  const el = document.getElementById('template');
  const current = el.value;
  const names = Object.keys(persistence.templates());
  el.replaceChildren(
    new Option('模板', ''),
    new Option('保存为模板…', '__save__'),
    new Option('删除当前模板…', '__delete__'),
    ...names.map(n => new Option(n, `tpl:${n}`))
  );
  el.value = current;
}

async function applyLayout(layout) {
  if (!layout) return;
  restoringSession = true;
  try {
    if (layout.symbol && symbolsCache.some(s => s.code === layout.symbol)) {
      state.symbol = layout.symbol;
      controls.setSymbol(state.symbol);
    }
    if (layout.period) { state.period = layout.period; controls.setPeriod(state.period); }
    // 隐波开关随会话/布局一起恢复，否则从总览页整页跳回后所有图的隐波都会消失。
    vixEnabled = !!layout.vixEnabled;
    document.getElementById('vix-toggle').classList.toggle('active', vixEnabled);
    chart.loadLayout(layout);
    pendingViewport = layout.viewport || null;
    alerts.load(layout.alerts || []);
    renderAlerts();
    controls.setPaneCount(chart.panes.length);
    refreshMenus();
    if (layout.compare?.symbol) await loadCompare(layout.compare.symbol);
    else { compareData = null; chart.setCompare('', []); }
    await load();
    // 从桌面全览布局恢复到窄屏时，柱宽过小会让 K 线糊成一条线、且自动线在屏幕外。
    if (window.matchMedia('(max-width: 760px)').matches && chart.vp.barWidth < 0.9) {
      chart.fitRecent(160);
    }
  } finally {
    restoringSession = false;
  }
}

document.getElementById('layout-save').addEventListener('click', () => saveLayout());
document.getElementById('layout-load').addEventListener('click', () => {
  const layout = persistence.get('layout');
  if (!layout) { controls.setStatus('没有已保存的布局', true); return; }
  applyLayout(layout);
});
document.getElementById('template').addEventListener('change', async e => {
  const v = e.target.value;
  e.target.value = '';
  if (v === '__save__') {
    const name = window.prompt('模板名称', `${state.symbol}-${state.period}`);
    if (name) { persistence.saveTemplate(name, captureFullLayout()); refreshTemplates(); controls.setStatus(`模板 ${name} 已保存`); }
  } else if (v === '__delete__') {
    const all = Object.keys(persistence.templates());
    const name = all.length ? window.prompt('删除哪个模板？\n' + all.join('\n')) : null;
    if (name && persistence.deleteTemplate(name)) { refreshTemplates(); controls.setStatus(`模板 ${name} 已删除`); }
  } else if (v.startsWith('tpl:')) {
    const layout = persistence.loadTemplate(v.slice(4));
    if (layout) { await applyLayout(layout); controls.setStatus(`已加载模板 ${v.slice(4)}`); }
  }
});

/* ---------- 截图 / 全屏 / 命令面板 ---------- */
function exportPNG() {
  const active = multiView?.enabled ? multiView.cells[multiView.activeId] : null;
  const targetCanvas = active?.canvas || canvas;
  const period = active?.period || state.period;
  const a = document.createElement('a');
  a.download = `${state.symbol}_${period}_${Date.now()}.png`;
  a.href = targetCanvas.toDataURL('image/png');
  a.click();
  controls.setStatus('截图已导出');
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}
document.getElementById('snapshot').addEventListener('click', exportPNG);
document.getElementById('fullscreen').addEventListener('click', toggleFullscreen);

const palette = new CommandPalette();
document.getElementById('cmd-btn').addEventListener('click', () => palette.open());
palette.setCommands([
  { title: '上一个品种', group: '品种', keywords: 'prev symbol 上一个 翻页 PageUp', run: () => controls.stepSymbol(-1) },
  { title: '下一个品种', group: '品种', keywords: 'next symbol 下一个 翻页 PageDown', run: () => controls.stepSymbol(1) },
  ...PERIOD_LIST.map(([id, label]) => ({ title: `周期：${label}`, group: '视图', keywords: id, run: () => { controls.setPeriod(id); applyPeriod(id); } })),
  { title: '四视图：开启 / 还原', group: '视图', keywords: '四视图 four view 30m 1h 1d 1w', run: () => mvButton.click() },
  { title: '隐波：叠加 / 关闭（独立纵轴）', group: '指标', keywords: 'vix 隐波 波动率 叠加', run: () => document.getElementById('vix-toggle').click() },
  { title: '神奇九转：叠加 / 关闭', group: '指标', keywords: '九转 nine TD 神奇九转 1-9 13', run: () => nineBtn.click() },
  { title: '打开隐波总览页', group: '工具', keywords: 'vix 隐波 总览 列表', run: () => { location.href = './vix.html'; } },
  { title: '显示全部历史', group: '视图', keywords: 'all fit', run: () => chart.fitAll() },
  { title: '回到最新 K 线', group: '视图', keywords: 'latest end', run: () => chart.fit() },
  ...PANE_OPTIONS.map(id => ({ title: `添加副图：${REGISTRY[id].short}`, group: '指标', keywords: id, run: () => { chart.addPane(id); controls.setPaneCount(chart.panes.length); } })),
  ...OVERLAY_OPTIONS.filter(id => id !== 'nine').map(id => ({ title: `主图叠加：${id === 'channel' ? '自动线' : REGISTRY[id].short}`, group: '指标', keywords: id, run: () => { const o = chart.addOverlay(id); refreshMenus(); if (o) openSettings({ kind: 'overlay', id: o.id, indicator: o.id, x: 300, y: 120 }); } })),
  { title: '自动线：通道 / 趋势线', group: '自动线', keywords: 'channel 通道', run: () => setAutoLine(0) },
  { title: '自动线：支撑线', group: '自动线', keywords: 'support 支撑', run: () => setAutoLine(1) },
  { title: '自动线：压力线', group: '自动线', keywords: 'resistance 压力', run: () => setAutoLine(2) },
  { title: '自动线：支撑 + 压力线（同时）', group: '自动线', keywords: 'both support resistance 支撑 压力 同时', run: () => setAutoLine(3) },
  { title: '自动线：切换「突破后重连新线」', group: '自动线', keywords: 'breakout 突破 新高 连线', run: () => {
    const o = chart.panes.getOverlay('channel');
    const cur = Number(o?.params?.breakout ?? 1) ? 1 : 0;
    ensureChannel({ breakout: cur ? 0 : 1 });
    controls.setStatus(cur ? '已关闭「突破后重连新线」' : '已开启「突破后重连新线」');
  } },
  { title: '自动线：切换「显著高低点通道」', group: '自动线', keywords: 'major pivot 显著 高低点 长通道 主要顶底', run: () => {
    const o = chart.panes.getOverlay('channel');
    const cur = Number(o?.params?.major ?? 1) ? 1 : 0;
    ensureChannel({ major: cur ? 0 : 1 });
    controls.setStatus(cur ? '已关闭「显著高低点通道」' : '已开启「显著高低点通道」');
  } },
  { title: '移除自动线', group: '自动线', keywords: 'remove 清除 自动线', run: () => { chart.removeOverlay('channel'); refreshMenus(); scheduleSessionSave(); } },
  ...DRAW_TOOLS.map(t => ({ title: `工具：${TOOL_LABELS[t]}`, group: '绘图', keywords: t, run: () => selectTool(t) })),
  { title: '清除所有绘图', group: '绘图', keywords: 'clear', run: () => chart.clearTools() },
  { title: '撤销上一步绘图', group: '绘图', keywords: 'undo', run: () => chart.tools.undo() },
  { title: '保存布局', group: '布局', keywords: 'save', run: () => saveLayout() },
  { title: '恢复布局', group: '布局', keywords: 'load restore', run: () => { const l = persistence.get('layout'); if (l) applyLayout(l); else controls.setStatus('没有已保存的布局', true); } },
  { title: '启用多品种对比', group: '对比', keywords: 'compare', run: () => { comparePanel.hidden = false; } },
  { title: '关闭多品种对比', group: '对比', keywords: 'compare off', run: () => { compareData = null; chart.setCompare('', []); } },
  { title: '打开价格警报', group: '警报', keywords: 'alert', run: () => { alertPanel.hidden = false; } },
  { title: '导出 PNG 截图', group: '工具', keywords: 'png image', run: exportPNG },
  { title: '切换全屏', group: '工具', keywords: 'fullscreen', run: toggleFullscreen },
]);

/* ---------- 实时行情 ---------- */
// 普通视图的订阅只能写单图：这里若用 chart 代理，四视图打开后会把
// 全局合约/周期的 tick 写进「当前激活格」，造成跨品种、跨周期数据污染
// （表现为 K 线突然断崖、均线与价格完全不是一个量级）。
function onTick(msg) {
  singleChart.tick(msg.bar);
  controls.setQuote(msg.quote);
  alerts.check(msg.quote?.symbol || state.symbol, msg.quote?.price);
}

const feed = new Feed(
  onTick,
  (text, error) => controls.setStatus(text, error),
  (bars) => singleChart.mergeBars(bars)
);

/** 记录"屏幕中心那根 K 线的时间"，供切换周期/合约后还原视口。 */
function captureViewAnchor(c, targetPeriod) {
  const vp = c.vp;
  const bars = c.store.bars;
  if (!bars.length || !vp.width) return null;
  const centerX = vp.left + vp.plotWidth / 2;
  const idx = Math.max(0, Math.min(bars.length - 1, Math.round(vp.xToIndex(centerX))));
  return {
    ts: bars[idx].ts,
    fromPeriod: c.store.period,
    toPeriod: targetPeriod || state.period,
    barWidth: vp.barWidth,
    centerX,
    index: idx,
    fraction: bars.length > 1 ? idx / (bars.length - 1) : 0,
  };
}

/**
 * 切换周期/合约后按时间锚点还原视口：让锚点时间仍落在屏幕中心，
 * 并按周期分钟比例换算柱宽，使可见时间跨度尽量不变。
 * 锚点时间超出新数据范围时退化为定位最新。
 */
function restoreViewAnchor(c, a) {
  if (!a) return false;
  const vp = c.vp;
  const bars = c.store.bars;
  if (!bars.length) return false;

  // 同一周期换合约：保持屏幕中间那根 K 线在历史中的相对位置和柱宽，
  // 不用时间戳去找（不同合约的停牌/上市时间会让锚点越界，K 线被推到屏幕外）。
  if (a.fromPeriod === a.toPeriod && Number.isFinite(a.fraction)) {
    const bw = Math.min(vp.maxBarWidth, Math.max(vp.minBarWidth,
      Number.isFinite(a.barWidth) ? a.barWidth : vp.barWidth));
    vp.barWidth = bw;
    const idx = Math.round(Math.max(0, Math.min(1, a.fraction)) * (bars.length - 1));
    const centerX = Number.isFinite(a.centerX) ? a.centerX : vp.left + vp.plotWidth / 2;
    const wantedFirst = idx + 0.5 - (centerX - vp.left) / bw;
    vp.setRawFirst(wantedFirst < vp.minFirst ? -0.5 : wantedFirst);
    vp.clamp();
    vp.emit('viewport', vp);
    return true;
  }

  const last = bars[bars.length - 1];
  if (a.ts > last.ts) { vp.fitToEnd(bars.length); return true; }

  // 保持可见时间跨度：柱宽按周期倍数换算（5m→15m 一根变宽 3 倍）。
  // 两端都要兜底：
  // - 放大端（5m→1d）柱宽会算到上千像素，clamp 后只剩 7~8 根，像"图表空了"；
  //   限制为「视野里至少 40 根」。
  // - 缩小端（1d→1h / 1w→1h）柱宽会缩到 minBarWidth(0.25px)，1500 根挤成一条细线，
  //   K 线和成交量都看不清；限制为「视野里最多 160 根」，与首次进入的默认视野一致。
  const fromMin = PERIOD_MINUTES[a.fromPeriod] || 1;
  const toMin = PERIOD_MINUTES[a.toPeriod] || 1;
  const wanted = a.barWidth * toMin / fromMin;
  const maxBarWidth = Math.max(vp.minBarWidth, vp.plotWidth / 40);
  const minBarWidth = Math.max(vp.minBarWidth, vp.plotWidth / 160);
  vp.barWidth = Math.min(vp.maxBarWidth, Math.max(minBarWidth, Math.min(wanted, maxBarWidth)));

  // 二分找锚点时间对应的新索引（bars 按 ts 有序）
  let lo = 0, hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].ts < a.ts) lo = mid + 1; else hi = mid;
  }
  let idx = lo;
  if (idx > 0 && Math.abs(bars[idx - 1].ts - a.ts) < Math.abs(bars[idx].ts - a.ts)) idx -= 1;
  // 让 idx 落在 centerX：first = idx + 0.5 - (centerX - left) / barWidth
  // 锚点比可见数据还早时不要把第一根 K 线推到左边留一大片空白，贴左对齐即可。
  const wantedFirst = idx + 0.5 - (a.centerX - vp.left) / vp.barWidth;
  vp.setRawFirst(wantedFirst < vp.minFirst ? -0.5 : wantedFirst);
  vp.clamp();
  vp.emit('viewport', vp);
  return true;
}

async function load(options = {}) {
  // 普通视图专用：始终写 singleChart。四视图开启期间若还有在途请求，
  // 走 chart 代理会落进「当前激活格」，把 30m 格覆盖成 5m 数据。
  // 注意初始化恢复四视图时 activeChart() 还没有实例，此时仍需加载单图，
  // 否则退出四视图后单图的视口/缩放会丢。
  if (multiView?.enabled && multiView.activeChart()) return;
  const viewAnchor = options.keepView ? captureViewAnchor(singleChart, state.period) : null;
  const token = ++loadToken;
  controls.setStatus('加载中…');
  try {
    const data = await api.bars(state.symbol, state.period, 1500);
    if (token !== loadToken || (multiView?.enabled && multiView.activeChart())) return;
    singleChart.setData(data.bars, { symbol: data.symbol, period: data.period, digits: data.digits });
    // 以「实际加载成功的数据周期」为准，避免请求失败/竞态时按钮高亮与图例周期不一致。
    state.period = data.period;
    controls.setPeriod(data.period);
    if (pendingViewport) {
      const vp = singleChart.vp;
      if (Number.isFinite(pendingViewport.barWidth)) vp.barWidth = pendingViewport.barWidth;
      if (Number.isFinite(pendingViewport.first)) vp.setRawFirst(pendingViewport.first);
      pendingViewport = null;
    } else if (!restoreViewAnchor(singleChart, viewAnchor) && window.matchMedia('(max-width: 760px)').matches) {
      // 手机首次进入：只显示最近一段，柱宽足够看清 K 线；「全部」按钮仍可看全历史。
      singleChart.fitRecent(160);
    }
    feed.subscribe(data.symbol, data.period);
    controls.setStatus(`${data.bars.length} 根`);
    if (vixEnabled) await loadVixData(data.symbol, data.period);
    else applyVixOverlay();
  } catch (err) {
    if (token !== loadToken) return;
    // 加载失败时把周期高亮退回到图上实际数据，避免「日线高亮、1 分钟图」的错位。
    state.period = singleChart.store.period || state.period;
    controls.setPeriod(state.period);
    controls.setStatus(String(err.message || err), true);
  }
}

async function init() {
  try {
    const symbols = await api.symbols();
    symbolsCache = symbols;
    controls.populateSymbols(symbols, state.symbol);
    if (!symbols.some(s => s.code === state.symbol) && symbols.length) {
      state.symbol = symbols[0].code;
      controls.setSymbol(state.symbol);
    }
    populateCompareSymbols(symbols);
    const mvState = persistence.get('multiview');
    multiView.restoreState(mvState);
    controls.setPeriod(state.period);
    refreshMenus();
    refreshTemplates();
    renderAlerts();

    // 优先自动会话（含 F5 前的视口/缩放），没有再退回手动保存的布局。
    const saved = persistence.get('session') || persistence.get('layout');
    if (saved) await applyLayout(saved);
    else {
      await load();
      // 全新会话默认画出一条自动线，让「支撑 / 压力 / 通道」功能一眼可见；
      // 之后刷新走 session，不会覆盖用户手动删除/隐藏的选择。
      if (!chart.panes.hasOverlay('channel')) {
        chart.addOverlay('channel');
        refreshMenus();
        controls.setStatus('已启用自动线 · 点「自动线」可勾选支撑 / 压力 / 通道');
      }
    }
    feed.connect();
    // 刷新前处在四视图则原样恢复；各格周期来自 multiview 的独立记忆。
    if (multiView.enabled) {
      mvButton.classList.add('active');
      mvButton.title = '四视图：再点一次还原为普通界面';
      await multiView.open(state.symbol);
      if (vixEnabled) await loadVixForAllCharts();
    }
  } catch (err) {
    controls.setStatus(`初始化失败: ${err.message || err}`, true);
  }
}

document.addEventListener('pointerdown', e => {
  // 指标设置浮层点外面关闭的逻辑在 IndicatorSettings 内部（含点图表空白处关闭）。
  if (!paneMenu.hidden && !paneMenu.contains(e.target) && e.target !== canvas) closePaneMenu();
});

init();
controls.setPaneCount(chart.panes.length);
window.__kchart = { chart, singleChart, feed, state, handlePaneMenu, palette, alerts, settings, multiView, controls };


