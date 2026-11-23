export function drawVolume(ctx, g) {
  const { bars, start, end, indexToX, volTop, volH, barWidth } = g;
  let max = 0;
  for (let i = start; i <= end; i++) max = Math.max(max, bars[i]?.volume || 0);
  if (!max) return;
  const bodyW = Math.max(1, Math.min(12, barWidth - 2));
  ctx.save();
  for (let i = start; i <= end; i++) {
    const b = bars[i];
    if (!b) continue;
    const h = (b.volume / max) * (volH - 6);
    ctx.fillStyle = b.close >= b.open ? g.colors.upAlpha : g.colors.downAlpha;
    ctx.fillRect(Math.round(indexToX(i) - bodyW / 2), Math.round(volTop + volH - h), Math.round(bodyW), Math.round(h));
  }
  ctx.fillStyle = '#6d7c8e';
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText('VOL', g.left + 4, volTop + 12);
  ctx.restore();
}
