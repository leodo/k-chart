const $ = id => document.getElementById(id);
const state = { rows: [], sortKey: 'vix', sortDir: 'desc', series: [], symbol: '', name: '' };

const status = (text, error = false) => {
  const el = $('vix-status');
  el.textContent = text;
  el.style.color = error ? '#f0515a' : '';
};

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

function fmt(v, digits = 2) {
  return Number.isFinite(v) ? v.toFixed(digits) : '—';
}

function paintBar(v) {
  if (!Number.isFinite(v)) return '';
  const w = Math.max(2, Math.min(64, v * 1.6));
  const color = v >= 30 ? '#f0515a' : v >= 20 ? '#e2a33c' : '#2eb87c';
  return `<i class="vix-bar" style="width:${w}px;background:${color}"></i>`;
}

function sortedRows() {
  const q = $('vix-search').value.trim().toLowerCase();
  const exchange = $('vix-exchange').value;
  const key = state.sortKey;
  const factor = state.sortDir === 'desc' ? -1 : 1;
  return state.rows
    .filter(r => (!q || r.name.toLowerCase().includes(q) || r.symbol.toLowerCase().includes(q)) && (!exchange || r.exchange === exchange))
    .sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor;
      return String(av).localeCompare(String(bv), 'zh-CN') * factor;
    });
}

function renderTable() {
  const rows = sortedRows();
  const max = Math.max(1, ...rows.map(r => r.vix || 0));
  $('vix-tbody').innerHTML = rows.map(r => {
    const chg = Number.isFinite(r.change) ? r.change : null;
    const cls = chg == null ? '' : chg >= 0 ? 'vix-up' : 'vix-down';
    const chgText = chg == null ? '—' : `${chg >= 0 ? '+' : ''}${fmt(chg)}`;
    const disabled = Number.isFinite(r.vix) ? '' : ' class="disabled"';
    return `<tr data-symbol="${r.symbol}"${disabled}>
      <td>${r.symbol}</td><td>${r.name}</td><td>${r.exchange}</td>
      <td class="num">${paintBar(r.vix, max)}${Number.isFinite(r.vix) ? fmt(r.vix) : '—'}</td>
      <td class="num ${cls}">${chgText}</td>
      <td class="num">${fmt(r.iv_near)}</td>
      <td class="num">${fmt(r.iv_next)}</td>
      <td>${r.date || '—'}</td>
    </tr>`;
  }).join('');
  if (!rows.length) $('vix-tbody').innerHTML = '<tr class="disabled"><td colspan="8">没有匹配的品种</td></tr>';
}

function bindSort() {
  document.querySelectorAll('.vix-table th').forEach(th => {
    if (!th.dataset.key) return;
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (state.sortKey === key) state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
      else { state.sortKey = key; state.sortDir = ['symbol', 'name', 'exchange', 'date'].includes(key) ? 'asc' : 'desc'; }
      document.querySelectorAll('.vix-table th').forEach(x => {
        x.classList.remove('active', 'desc', 'asc');
        const arrow = x.querySelector('.sort-arrow');
        if (arrow) arrow.textContent = '↕';
      });
      th.classList.add('active', state.sortDir);
      const arrow = th.querySelector('.sort-arrow');
      if (arrow) arrow.textContent = state.sortDir === 'desc' ? '▼' : '▲';
      renderTable();
    });
  });
}

async function loadList() {
  try {
    state.rows = await getJSON('/api/vix/list');
    const exchanges = [...new Set(state.rows.map(r => r.exchange))].sort();
    const select = $('vix-exchange');
    const current = select.value;
    select.replaceChildren(new Option('全部', ''), ...exchanges.map(e => new Option(e, e)));
    select.value = current;
    renderTable();
    const ready = state.rows.filter(r => Number.isFinite(r.vix)).length;
    status(`${state.rows.length} 个品种 · ${ready} 个已有隐波数据`);
  } catch (err) {
    status(String(err.message || err), true);
  }
}

/* ---------- 详情折线图 ---------- */
const canvas = $('vix-canvas');
const ctx = canvas.getContext('2d');
let hoverIndex = -1;

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawChart();
}

function geometry() {
  const w = canvas.getBoundingClientRect().width;
  const h = canvas.getBoundingClientRect().height;
  const left = 54, right = 66, top = 20, bottom = 34;
  const values = state.series.map(p => p.vix).filter(Number.isFinite);
  let lo = Math.min(...values), hi = Math.max(...values);
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  const pad = Math.max((hi - lo) * 0.1, 0.5);
  lo -= pad; hi += pad;
  const n = state.series.length;
  return {
    w, h, left, right, top, bottom, lo, hi, n,
    plotW: Math.max(1, w - left - right),
    plotH: Math.max(1, h - top - bottom),
    x: i => left + (n <= 1 ? 0 : (i / (n - 1)) * (w - left - right)),
    y: v => top + ((hi - v) / (hi - lo)) * (h - top - bottom),
  };
}

function drawChart() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, canvas.getBoundingClientRect().width, canvas.getBoundingClientRect().height);
  const data = state.series;
  if (!data.length) return;
  const g = geometry();

  ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const value = g.hi - (g.hi - g.lo) * i / 4;
    const y = Math.round(g.y(value)) + 0.5;
    ctx.strokeStyle = '#1b2531';
    ctx.beginPath(); ctx.moveTo(g.left, y); ctx.lineTo(g.w - g.right, y); ctx.stroke();
    ctx.fillStyle = '#7d8b9c';
    ctx.textAlign = 'left';
    ctx.fillText(value.toFixed(1), g.w - g.right + 6, y);
  }
  const tickCount = Math.min(7, Math.max(2, Math.floor(g.plotW / 110)));
  for (let i = 0; i <= tickCount; i++) {
    const idx = Math.round((data.length - 1) * i / tickCount);
    const x = Math.round(g.x(idx)) + 0.5;
    ctx.strokeStyle = '#1b2531';
    ctx.beginPath(); ctx.moveTo(x, g.top); ctx.lineTo(x, g.h - g.bottom); ctx.stroke();
    ctx.fillStyle = '#7d8b9c';
    ctx.textAlign = i === 0 ? 'left' : i === tickCount ? 'right' : 'center';
    ctx.fillText(data[idx].date.slice(5), x, g.h - g.bottom + 14);
  }

  const grad = ctx.createLinearGradient(0, g.top, 0, g.top + g.plotH);
  grad.addColorStop(0, 'rgba(181,123,255,.30)');
  grad.addColorStop(1, 'rgba(181,123,255,0)');
  ctx.beginPath();
  data.forEach((p, i) => i ? ctx.lineTo(g.x(i), g.y(p.vix)) : ctx.moveTo(g.x(i), g.y(p.vix)));
  ctx.lineTo(g.x(data.length - 1), g.top + g.plotH);
  ctx.lineTo(g.x(0), g.top + g.plotH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  data.forEach((p, i) => i ? ctx.lineTo(g.x(i), g.y(p.vix)) : ctx.moveTo(g.x(i), g.y(p.vix)));
  ctx.strokeStyle = '#b57bff';
  ctx.lineWidth = 1.8;
  ctx.stroke();

  if (hoverIndex >= 0 && hoverIndex < data.length) {
    const p = data[hoverIndex];
    const x = Math.round(g.x(hoverIndex)) + 0.5;
    const y = g.y(p.vix);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#7d8b9c';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, g.top); ctx.lineTo(x, g.h - g.bottom); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#b57bff';
    ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill();

    const lines = [
      `${p.date}  VIX ${fmt(p.vix)}`,
      `近月 IV ${fmt(p.iv_near)}%  次月 IV ${fmt(p.iv_next)}%`,
    ];
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
    const w = Math.max(...lines.map(t => ctx.measureText(t).width)) + 16;
    const bx = Math.min(g.w - g.right - w - 4, Math.max(g.left + 4, x + 12));
    const by = g.top + 6;
    ctx.fillStyle = 'rgba(13,17,23,.92)';
    ctx.strokeStyle = '#3a4a5e';
    ctx.fillRect(bx, by, w, 38);
    ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, 37);
    ctx.fillStyle = '#d7e0ea';
    ctx.textAlign = 'left';
    ctx.fillText(lines[0], bx + 8, by + 12);
    ctx.fillStyle = '#9fb0c4';
    ctx.fillText(lines[1], bx + 8, by + 27);
  }
}

canvas.addEventListener('mousemove', e => {
  if (!state.series.length) return;
  const rect = canvas.getBoundingClientRect();
  const g = geometry();
  const x = e.clientX - rect.left;
  hoverIndex = Math.max(0, Math.min(state.series.length - 1, Math.round((x - g.left) / g.plotW * (state.series.length - 1))));
  drawChart();
});
canvas.addEventListener('mouseleave', () => { hoverIndex = -1; drawChart(); });
new ResizeObserver(resizeCanvas).observe(canvas);

async function showDetail(symbol) {
  state.symbol = symbol;
  $('vix-list-view').hidden = true;
  $('vix-detail-view').hidden = false;
  const row = state.rows.find(r => r.symbol === symbol);
  $('vix-detail-title').textContent = `${row?.name || symbol} (${symbol}) · 隐波走势`;
  status('加载隐波序列…');
  try {
    const data = await getJSON(`/api/vix/series?symbol=${encodeURIComponent(symbol)}`);
    state.series = data.series || [];
    state.name = data.name;
    const last = state.series[state.series.length - 1];
    $('vix-detail-meta').textContent = last
      ? `${state.series.length} 个交易日 · ${state.series[0].date} 至 ${last.date} · 近月 ${last.expiry_near || '—'}`
      : '暂无数据';
    $('vix-detail-last').textContent = last ? fmt(last.vix) : '—';
    resizeCanvas();
    status(`${state.series.length} 根日线`);
  } catch (err) {
    status(String(err.message || err), true);
  }
}

function showList() {
  $('vix-detail-view').hidden = true;
  $('vix-list-view').hidden = false;
  status(`${state.rows.length} 个品种`);
}

$('vix-tbody').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-symbol]');
  if (!tr || tr.classList.contains('disabled')) return;
  history.pushState({ symbol: tr.dataset.symbol }, '', `?symbol=${tr.dataset.symbol}`);
  showDetail(tr.dataset.symbol);
});
$('vix-back').addEventListener('click', () => {
  history.pushState({}, '', location.pathname);
  showList();
});
$('vix-search').addEventListener('input', renderTable);
$('vix-exchange').addEventListener('change', renderTable);
$('vix-refresh').addEventListener('click', async () => {
  try {
    await getJSON('/api/vix/refresh');
    status('后台重算已启动，稍后点此页面刷新即可看到新值');
  } catch (err) {
    status(String(err.message || err), true);
  }
});
window.addEventListener('popstate', () => {
  const symbol = new URLSearchParams(location.search).get('symbol');
  symbol ? showDetail(symbol) : showList();
});

async function init() {
  bindSort();
  await loadList();
  const symbol = new URLSearchParams(location.search).get('symbol');
  if (symbol) showDetail(symbol);
}
init();
