/** 指标绘制层：主图叠加线与副图线/柱，全部遵循实例样式（颜色/线宽/线型/可见性）。 */

const visible = (style, key) => style?.visible?.[key] !== false;

export function drawOverlayLines(ctx, g) {
  // 外推段会越过最新 K 线，必须裁到主图绘图区内，避免画到价格轴上。
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.left, g.main.top, g.width - g.left - g.right, g.main.height);
  ctx.clip();
  for (const o of g.overlays || []) {
    if (o.hidden) continue;
    const data = g.engine.get(o.id, g.bars, g.version, o.params);
    if (!data) continue;
    for (const line of data.lines) {
      if (!visible(o.style, line.key)) continue;
      drawLine(ctx, g, g.main, line, o.style, g.endDraw ?? g.end);
    }
    // 文字标记（MOS 的 ●底部结构 / ▲低点 等）：跟着 K 线走，压在图上方。
    if (data.markers?.length) drawMarkers(ctx, g, data.markers);
    // 触点圆圈已移除：它会压在 K 线上挡住形态，用户明确要求不要画。
  }
  ctx.restore();
}

/**
 * 主图文字标记：锚在 K 线的高点/低点，用固定像素偏移贴在 K 线上方或下方，
 * 而不是按价格比例（L*0.994 之类）偏移 —— 否则价格高、视野窄时标签会飘出去很远。
 */
function drawMarkers(ctx, g, markers) {
  const end = g.endDraw ?? g.end;
  const { top, bottom } = g.main;
  ctx.save();
  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const lastX = new Map();
  const stack = new Map();
  const minX = g.left + 24;
  const maxX = g.width - g.right - 24;
  for (const m of markers) {
    if (m.i < g.start || m.i > end) continue;
    const anchorY = g.main.priceToY(m.price);
    // 锚点已经跑出面板（那根 K 线本身不可见）就不画，避免标签贴着边缘乱飘。
    if (anchorY < top - 16 || anchorY > bottom + 16) continue;
    // 贴边时把文字收回绘图区内，避免只剩半个标记。
    const x = Math.max(minX, Math.min(maxX, g.indexToX(m.i)));
    // 同类标记挨太近就不画，避免文字叠在一起糊成一片。
    const prev = lastX.get(m.text);
    if (prev != null && Math.abs(x - prev) < 46) continue;
    // 同一根 K 线同侧的多个标记依次往外叠，不互相压住。
    const key = `${m.i}|${m.side}`;
    const depth = stack.get(key) || 0;
    stack.set(key, depth + 1);
    const gap = 12 + depth * 13;
    const y = Math.max(top + 9, Math.min(bottom - 9,
      m.side === 'below' ? anchorY + gap : anchorY - gap));
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(13, 17, 23, .82)';
    ctx.strokeText(m.text, x, y);
    ctx.fillStyle = m.color;
    ctx.fillText(m.text, x, y);
    lastX.set(m.text, x);
  }
  ctx.restore();
}

export function drawIndicatorPane(ctx, g, pane) {
  if (!pane.data) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.left, pane.top, g.width - g.left - g.right, pane.height);
  ctx.clip();

  if (pane.indicator === 'rsi') {
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = '#374458';
    ctx.lineWidth = 1;
    for (const level of [30, 70]) {
      const y = Math.round(pane.priceToY(level)) + 0.5;
      ctx.beginPath(); ctx.moveTo(g.left, y); ctx.lineTo(g.width - g.right, y); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  for (const line of pane.data.lines) {
    if (!visible(pane.style, line.key)) continue;
    if (line.type === 'hist') drawHistogram(ctx, g, pane, line, pane.style);
    else drawLine(ctx, g, pane, line, pane.style);
  }
  ctx.restore();
}

function drawLine(ctx, g, pane, line, style, endIndex = g.end) {
  const start = g.start;
  const end = Math.min(endIndex, line.values.length - 1);
  ctx.save();
  ctx.strokeStyle = style?.lineColors?.[line.key] || line.color;
  ctx.lineWidth = Math.max(0.4, Number(style?.lineWidth) || 1.2);
  if (style?.lineStyle === 'dashed') ctx.setLineDash([5, 3]);
  else if (style?.lineStyle === 'dotted') ctx.setLineDash([1, 3]);
  ctx.beginPath();
  let started = false;
  for (let i = start; i <= end; i++) {
    const v = line.values[i];
    if (!Number.isFinite(v)) { started = false; continue; }
    const x = g.indexToX(i);
    const y = pane.priceToY(v);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawHistogram(ctx, g, pane, line, style) {
  const { start, end, barWidth } = g;
  const bw = Math.max(1, Math.min(12, barWidth - 1));
  const zero = Math.min(pane.bottom, Math.max(pane.top, pane.priceToY(0)));
  const values = line.values;
  const sign = line.sign || values;
  const colors = style?.histColors?.[line.key] || { up: '#f0515a', down: '#2eb87c' };
  ctx.save();
  ctx.globalAlpha = 0.45;
  for (const positive of [true, false]) {
    ctx.fillStyle = positive ? colors.up : colors.down;
    for (let i = start; i <= end; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      if ((sign[i] >= 0) !== positive) continue;
      const y = pane.priceToY(v);
      const top = Math.min(y, zero);
      const h = Math.max(1, Math.abs(y - zero));
      ctx.fillRect(Math.round(g.indexToX(i) - bw / 2), Math.round(top), Math.max(1, Math.round(bw)), Math.round(h));
    }
  }
  ctx.restore();
}
