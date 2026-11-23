/** 绘图与对比图层：只认识“数据坐标”图形，不认识具体工具。 */

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

export function drawCompare(ctx, g) {
  const c = g.compare;
  if (!c) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.left, g.main.top, g.width - g.left - g.right, g.main.height);
  ctx.clip();
  ctx.strokeStyle = c.color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  let started = false;
  for (let i = g.start; i <= g.end; i++) {
    const v = c.values[i];
    if (!Number.isFinite(v)) { started = false; continue; }
    const x = g.indexToX(i), y = c.toY(v);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();

  const idx = Math.max(0, Math.min(g.bars.length - 1,
    Math.round(g.xToIndex(g.crosshair?.x ?? (g.width - g.right - 40)))));
  const v = c.values[idx];
  if (Number.isFinite(v)) {
    ctx.fillStyle = c.color;
    ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${v >= 0 ? '+' : ''}${v.toFixed(2)}%`, g.width - g.right + 6,
      Math.min(g.main.bottom - 8, Math.max(g.main.top + 8, c.toY(v))));
  }
  ctx.restore();
}

export function drawOverlays(ctx, g) {
  if (!g.shapes?.length) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.left, g.main.top, g.width - g.left - g.right, g.main.height);
  ctx.clip();
  for (const s of g.shapes) drawShape(ctx, g, s);
  ctx.restore();
}

function drawShape(ctx, g, s) {
  const color = s.color || '#f2c14e';
  const width = Math.max(0.6, Number(s.width) || 1.5);
  const a = { x: g.indexToX(s.i1), y: g.main.priceToY(s.p1) };
  const b = { x: g.indexToX(s.i2), y: g.main.priceToY(s.p2) };
  const selected = g.selected === s;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;

  if (s.type === 'horizontal') {
    line(ctx, g.left, a.y, g.width - g.right, a.y);
    label(ctx, `${s.p1.toFixed(g.priceDigits)}`, g.left + 4, a.y - 6, color);
  } else if (s.type === 'vertical') {
    line(ctx, a.x, g.main.top, a.x, g.timeAxisY);
    const bar = g.bars[Math.max(0, Math.min(g.bars.length - 1, Math.round(s.i1)))];
    if (bar) label(ctx, bar.time, a.x + 4, g.main.top + 12, color);
  } else if (s.type === 'ray') {
    const di = s.i2 - s.i1;
    if (Math.abs(di) > 1e-6) {
      const targetI = di > 0 ? g.xToIndex(g.width - g.right + 400) : g.xToIndex(g.left - 400);
      const targetP = s.p1 + (s.p2 - s.p1) * (targetI - s.i1) / di;
      line(ctx, a.x, a.y, g.indexToX(targetI), g.main.priceToY(targetP));
    }
  } else if (s.type === 'rect') {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    ctx.globalAlpha = 0.12;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.strokeRect(x, y, w, h);
  } else if (s.type === 'fib') {
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
    ctx.globalAlpha = 0.7;
    line(ctx, a.x, a.y, b.x, b.y);
    ctx.globalAlpha = 1;
    for (const level of FIB_LEVELS) {
      const price = s.p1 + (s.p2 - s.p1) * level;
      const y = g.main.priceToY(price);
      ctx.save();
      ctx.setLineDash(level === 0 || level === 1 ? [] : [4, 3]);
      ctx.globalAlpha = level === 0 || level === 1 ? 0.9 : 0.55;
      line(ctx, x1, y, x2, y);
      ctx.restore();
      label(ctx, `${(level * 100).toFixed(1)}%  ${price.toFixed(g.priceDigits)}`, x2 + 4, y, color);
    }
  } else if (s.type === 'measure') {
    line(ctx, a.x, a.y, b.x, b.y);
    const diff = s.p2 - s.p1;
    const pct = s.p1 ? diff / s.p1 * 100 : 0;
    const bars = Math.abs(s.i2 - s.i1);
    const text = `${diff >= 0 ? '+' : ''}${diff.toFixed(g.priceDigits)}  ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%  ${bars.toFixed(0)} 根`;
    label(ctx, text, (a.x + b.x) / 2 + 6, (a.y + b.y) / 2 - 12, color, true);
  } else if (s.type === 'text') {
    ctx.font = '12px -apple-system, "Microsoft YaHei", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.text || '文本', a.x + 7, a.y - 9);
  } else {
    line(ctx, a.x, a.y, b.x, b.y);
  }

  if (selected && s.type !== 'text') {
    ctx.save();
    ctx.setLineDash([3, 2]);
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.7;
    ctx.strokeRect(Math.min(a.x, b.x) - 5, Math.min(a.y, b.y) - 5,
      Math.abs(b.x - a.x) + 10, Math.abs(b.y - a.y) + 10);
    ctx.restore();
  }
  if (selected || s.type !== 'text') {
    ctx.fillRect(a.x - 2.5, a.y - 2.5, 5, 5);
    if (s.type !== 'horizontal' && s.type !== 'vertical') ctx.fillRect(b.x - 2.5, b.y - 2.5, 5, 5);
  }
  ctx.restore();
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}

function label(ctx, text, x, y, color, boxed = false) {
  ctx.save();
  ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
  ctx.textBaseline = 'middle';
  if (boxed) {
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = 'rgba(13,17,23,.85)';
    ctx.fillRect(x - 5, y - 9, w, 18);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}
