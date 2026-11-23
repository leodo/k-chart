/**
 * 端到端截图：用 Edge headless + CDP 打开本地 k-chart，设置自动线参数后截图。
 *
 * 用法:
 *   node scripts/e2e_shot.mjs <out.png> [--side=0] [--count=1] [--extend=12] [--period=1d] [--symbol=30:RBL9]
 *
 * 需要后端已在 127.0.0.1:8765 运行（start.bat）。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const out = path.resolve(args.find(a => !a.startsWith('--')) || 'shot.png');
const opt = (name, def) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
const side = Number(opt('side', 0));
const count = Number(opt('count', 1));
const extend = Number(opt('extend', 12));
const symbol = opt('symbol', '');
const period = opt('period', '');
const port = Number(opt('port', 9339));
const url = opt('url', 'http://127.0.0.1:8765/');
const winW = Number(opt('width', 1400));
const winH = Number(opt('height', 900));

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = await mkdtemp(path.join(tmpdir(), 'kchart-shot-'));
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', `--window-size=${winW},${winH}`, `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, url,
], { stdio: 'ignore', detached: false });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let target = null;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch { /* 还没起来 */ }
}
if (!target) { child.kill(); throw new Error('CDP 没起来'); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise(res => {
  const id = ++seq;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + JSON.stringify(r.result.exceptionDetails.exception?.description || ''));
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');

// 等数据到位
for (let i = 0; i < 80; i++) {
  const n = await evaluate('window.__kchart ? window.__kchart.chart.store.length : -1');
  if (n > 100) break;
  await sleep(250);
}

const info = await evaluate(`(() => {
  const k = window.__kchart;
  if (!k) return { error: 'no __kchart' };
  return { bars: k.chart.store.length, symbol: k.state.symbol, period: k.state.period };
})()`);

// 切品种/周期（可选），等重新加载
if (period) {
  await evaluate(`document.querySelector('#periods button[data-period="${period}"]')?.click()`);
  await sleep(1500);
}
if (symbol) {
  await evaluate(`(() => { const el = document.getElementById('symbol'); el.value = ${JSON.stringify(symbol)}; el.dispatchEvent(new Event('change')); })()`);
  await sleep(1500);
}
for (let i = 0; i < 40; i++) {
  const ready = await evaluate('window.__kchart.chart.store.length > 100 && !document.getElementById("status")?.textContent.includes("加载")');
  if (ready) break;
  await sleep(250);
}

// 设置自动线参数并重绘（顺便移除均线叠加，避免遮挡）
const applied = await evaluate(`(() => {
  const { chart } = window.__kchart;
  chart.removeOverlay('ma');
  ${opt('overlay', '') ? `chart.addOverlay(${JSON.stringify(opt('overlay', ''))});` : ''}
  let o = chart.panes.getOverlay('channel');
  if (!o) o = chart.addOverlay('channel');
  chart.setOverlayParams(o.id, { ...o.params, side: ${side}, count: ${count}, extend: ${extend} });
  if (${Number(opt('recent', 0))} > 0) chart.fitRecent(${Number(opt('recent', 0))});
  else if (!${args.includes('--nofit')}) chart.fit();
  const p = chart.panes.getOverlay(o.id).params;
  const data = chart.renderer.engine.get('channel', chart.store.bars, chart.store.version, p);
  const mo = ${opt('overlay', '') ? `chart.panes.getOverlay(${JSON.stringify(opt('overlay', ''))})` : 'null'};
  const md = mo ? chart.renderer.engine.get(mo.id, chart.store.bars, chart.store.version, mo.params) : null;
  return { params: p, supports: data?.supportCount, lines: data?.lines?.map(l => l.key),
    overlay: mo ? { id: mo.id, params: mo.params, lines: md?.lines?.length, markers: md?.markers?.length } : null };
})()`);

await sleep(900);
if (args.includes('--open-settings')) {
  const id = opt('overlay', '') || 'channel';
  await evaluate(`window.__kchart.settings.open({ kind: 'overlay', id: ${JSON.stringify(id)}, indicator: ${JSON.stringify(id)}, x: 320, y: 120 })`);
  await sleep(500);
}
let checked = null;
const actions = opt('actions', '');
if (actions === 'diag') {
  checked = await evaluate(`(() => {
    document.getElementById('toolbar-more')?.click();
    const chart = window.__kchart.chart;
    const g = chart.renderer._geometry || {};
    return { firstIndex: chart.vp.firstIndex, barWidth: chart.vp.barWidth,
      visibleCount: chart.vp.visibleCount, bars: chart.store.length,
      start: g.start, end: g.end, endDraw: g.endDraw,
      canvasH: chart.renderer.height, canvasW: chart.renderer.width,
      chartH: document.getElementById('chart').getBoundingClientRect().height };
  })()`);
  await sleep(800);
} else if (actions === 'realtime') {
  checked = await evaluate(`(async () => {
    const chart = window.__kchart.chart;
    const key = () => chart.panes.getOverlay('mos');
    const snap = () => {
      const o = key();
      const data = o ? chart.renderer.engine.get('mos', chart.store.bars, chart.store.version, o.params) : null;
      const lastBar = chart.store.bars[chart.store.bars.length - 1];
      return { version: chart.store.version, lastTs: lastBar?.ts, close: lastBar?.close,
        mosLast: data?.lines?.[0]?.values?.[chart.store.length - 1] ?? null,
        markers: data?.markers?.length ?? 0, status: document.getElementById('status').textContent };
    };
    const before = snap();
    await new Promise(r => setTimeout(r, 3000));
    const afterWait = snap();
    // 模拟一笔成交：修复写最后一根，看指标是否立刻重算
    const bars = chart.store.bars;
    const last = { ...bars[bars.length - 1] };
    last.close = last.close + 5;
    last.high = Math.max(last.high, last.close);
    chart.tick(last);
    await new Promise(r => setTimeout(r, 120));
    const afterTick = snap();
    return { before, afterWait: { version: afterWait.version, status: afterWait.status },
      tickChangedVersion: afterTick.version > afterWait.version,
      tickChangedMos: afterTick.mosLast !== afterWait.mosLast, afterTick };
  })()`);
  await sleep(300);
} else if (actions === 'mos-diag') {
  checked = await evaluate(`(() => {
    const chart = window.__kchart.chart;
    const g = chart.renderer._geometry;
    const mo = chart.panes.getOverlay('mos');
    if (!mo || !g) return { error: 'no mos geometry' };
    const data = chart.renderer.engine.get('mos', chart.store.bars, chart.store.version, mo.params);
    const vis = data.markers.filter(m => m.i >= g.start && m.i <= g.end).slice(0, 8);
    return {
      main: { top: g.main.top, bottom: g.main.bottom, lo: g.main.lo, hi: g.main.hi },
      start: g.start, end: g.end,
      markers: vis.map(m => ({ i: m.i, text: m.text, price: Number(m.price.toFixed(2)),
        y: Number(g.main.priceToY(m.price).toFixed(1)), side: m.side })),
    };
  })()`);
  await sleep(200);
} else if (actions === 'open-more') {  checked = await evaluate(`(() => {
    document.getElementById('toolbar-more').click();
    const el = document.getElementById('toolbar-extra');
    return { open: getComputedStyle(el).display !== 'none', width: Math.round(el.getBoundingClientRect().width) };
  })()`);
  await sleep(1200);
} else if (actions === 'measure') {
  checked = await evaluate(`(() => {
    const bar = document.getElementById('toolbar');
    const kids = [...bar.querySelectorAll(':scope > *, .toolbar-extra > *')]
      .filter(el => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0);
    const total = kids.reduce((a, el) => a + el.getBoundingClientRect().width, 0);
    return { clientWidth: bar.clientWidth, count: kids.length, totalWidth: Math.round(total),
      vp: { barWidth: window.__kchart.chart.vp.barWidth, first: window.__kchart.chart.vp.firstIndex,
        width: window.__kchart.chart.vp.width, visible: window.__kchart.chart.vp.visibleCount },
      items: kids.map(el => ({ id: el.id || el.className, w: Math.round(el.getBoundingClientRect().width) })) };
  })()`);
  await sleep(100);
} else if (actions === 'open-menu') {
  checked = await evaluate(`(() => {
    document.getElementById('auto-lines').click();
    return { open: !document.getElementById('auto-lines-menu').hidden };
  })()`);
  await sleep(300);
} else if (actions === 'flow') {
  // 自动线菜单的勾选状态与实际画线是否一致（全不勾 => 0 条）
  checked = await evaluate(`(async () => {
    const log = [];
    const menu = document.getElementById('auto-lines-menu');
    const open = () => document.getElementById('auto-lines').click();
    const items = () => [...document.querySelectorAll('#auto-lines-menu .menu-item')];
    const state = () => {
      const chart = window.__kchart.chart;
      const o = chart.panes.getOverlay('channel');
      const data = chart.renderer.engine.get('channel', chart.store.bars, chart.store.version, o.params);
      return { trend: o.params.trend, side: o.params.side, major: o.params.major,
        breakout: o.params.breakout, supports: data?.supportCount ?? 0 };
    };
    const marks = () => {
      open();
      const out = items().filter(b => /^[☑☐]/.test(b.textContent.trim()))
        .map(b => b.textContent.trim().replace(/[（(].*$/, ''));
      menu.hidden = true;
      return out.join(' ');
    };
    const click = (text) => {
      open();
      const b = items().find(i => i.textContent.includes(text));
      if (b) b.click();
      menu.hidden = true;
    };
    log.push({ step: 'initial', ...state(), marks: marks() });
    click('自动趋势线'); log.push({ step: '关自动', ...state(), marks: marks() });
    click('自动趋势线'); log.push({ step: '开自动', ...state(), marks: marks() });
    click('压力线');   log.push({ step: '勾压力', ...state(), marks: marks() });
    click('支撑线');   log.push({ step: '加支撑', ...state(), marks: marks() });
    click('压力线');   log.push({ step: '去压力', ...state(), marks: marks() });
    click('支撑线');   log.push({ step: '去支撑', ...state(), marks: marks() });
    return log;
  })()`);
  await sleep(400);
} else if (actions === 'off-all') {
  // 像用户那样：把菜单里所有「☑」逐个点掉，验证「全不勾 = 一条不画」
  checked = await evaluate(`(() => {
    const menu = document.getElementById('auto-lines-menu');
    const openMenu = () => document.getElementById('auto-lines').click();
    const items = () => [...document.querySelectorAll('#auto-lines-menu .menu-item')];
    for (let i = 0; i < 8; i++) {
      openMenu();
      const on = items().filter(b => b.textContent.trim().startsWith('☑'));
      if (!on.length) { menu.hidden = true; break; }
      on[0].click();
    }
    const chart = window.__kchart.chart;
    const o = chart.panes.getOverlay('channel');
    const data = chart.renderer.engine.get('channel', chart.store.bars, chart.store.version, o.params);
    return { params: o.params, status: document.getElementById('status').textContent,
      supports: data?.supportCount, lines: data?.lines?.length };
  })()`);
  await sleep(700);
} else if (actions === 'settings-outside') {
  checked = await evaluate(`(async () => {
    const settings = window.__kchart.settings;
    settings.open({ kind: 'overlay', id: 'channel', indicator: 'channel', x: 320, y: 120 });
    await new Promise(r => setTimeout(r, 120));
    const opened = !document.getElementById('indicator-settings').hidden;
    const canvas = document.getElementById('canvas');
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
      clientX: rect.left + rect.width * 0.7, clientY: rect.top + rect.height * 0.6,
    }));
    await new Promise(r => setTimeout(r, 120));
    return { opened, closedAfterOutsideClick: document.getElementById('indicator-settings').hidden };
  })()`);
} else if (actions === 'gear-outside') {
  // 真实路径：点图例齿轮开浮层（不能被同一次点击立刻关掉），再点图表外关闭
  checked = await evaluate(`(async () => {
    const chart = window.__kchart.chart;
    const canvas = document.getElementById('canvas');
    const rect = canvas.getBoundingClientRect();
    const g = (chart.renderer._geometry.settingsIcons || []).find(i => i.id === 'channel');
    if (!g) return { error: 'no gear icon' };
    const fire = (x, y) => canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y,
    }));
    fire(rect.left + g.x + g.w / 2, rect.top + g.y + g.h / 2);
    await new Promise(r => setTimeout(r, 150));
    const opened = !document.getElementById('indicator-settings').hidden;
    fire(rect.left + rect.width * 0.7, rect.top + rect.height * 0.65);
    await new Promise(r => setTimeout(r, 150));
    return { opened, closedAfterOutsideClick: document.getElementById('indicator-settings').hidden };
  })()`);
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
await writeFile(out, Buffer.from(shot.result.data, 'base64'));
console.log(JSON.stringify({ ...info, applied, checked, out }, null, 2));

ws.close();
child.kill();
await sleep(300);
process.exit(0);
