/** 十字光标：竖线贯穿所有面板，横线停留在鼠标所在面板，各面板轴上显示对应数值。 */
export function drawCrosshair(ctx, g) {
  const c = g.crosshair;
  if (!c || c.x == null || c.y == null) return;
  const x = Math.round(c.x) + 0.5;

  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#7d8b9c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, g.panes[0].top);
  ctx.lineTo(x, g.timeAxisY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(g.left, Math.round(c.y) + 0.5);
  ctx.lineTo(g.width - g.right, Math.round(c.y) + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);

  const idx = Math.max(0, Math.min(g.bars.length - 1, Math.round(g.xToIndex(c.x))));
  const bar = g.bars[idx];
  ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
  ctx.textBaseline = 'middle';

  for (const pane of g.panes) {
    let value = NaN;
    let color = '#d7e0ea';
    if (pane.kind === 'price') {
      value = bar ? bar.close : NaN;
    } else if (pane.data?.lines?.length) {
      const line = pane.data.lines.find(l => l.type !== 'hist') || pane.data.lines[0];
      value = line.values[idx];
      color = line.color;
    }
    if (!Number.isFinite(value)) continue;
    const y = Math.min(pane.bottom - 1, Math.max(pane.top + 1, pane.priceToY(value)));
    const text = pane.kind === 'price' ? value.toFixed(g.priceDigits) : value.toFixed(2);
    drawTag(ctx, text, g.width - g.right + 2, y, 18, color);
  }

  if (bar) drawTag(ctx, bar.time, Math.min(g.width - 120, Math.max(g.left, x - 60)), g.timeAxisY + 2, 18, '#d7e0ea');
  ctx.restore();
}

function drawTag(ctx, text, x, yCenter, h, color) {
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = '#1b2430';
  ctx.strokeStyle = '#3a4a5e';
  ctx.fillRect(x, yCenter - h / 2, w, h);
  ctx.strokeRect(x + 0.5, yCenter - h / 2 + 0.5, w - 1, h - 1);
  ctx.fillStyle = color;
  ctx.fillText(text, x + 6, yCenter);
}
