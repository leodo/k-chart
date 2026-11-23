/** 主图蜡烛：只画可见索引区间，barWidth<1 时不画实体只画细线。 */
export function drawCandles(ctx, g) {
  const { bars, start, end, main, barWidth } = g;
  const bodyW = Math.max(1, Math.min(14, barWidth - 1));
  ctx.save();
  ctx.lineWidth = 1;
  // 影线按涨跌分批画，减少状态切换
  for (const up of [false, true]) {
    ctx.beginPath();
    for (let i = start; i <= end; i++) {
      const b = bars[i];
      if (!b || (b.close >= b.open) !== up) continue;
      const x = Math.round(g.indexToX(i)) + 0.5;
      ctx.moveTo(x, main.priceToY(b.high));
      ctx.lineTo(x, main.priceToY(b.low));
    }
    ctx.strokeStyle = up ? g.colors.up : g.colors.down;
    ctx.stroke();
  }
  for (const up of [false, true]) {
    ctx.fillStyle = up ? g.colors.up : g.colors.down;
    for (let i = start; i <= end; i++) {
      const b = bars[i];
      if (!b || (b.close >= b.open) !== up) continue;
      const x = g.indexToX(i);
      const y1 = main.priceToY(Math.max(b.open, b.close));
      const y2 = main.priceToY(Math.min(b.open, b.close));
      ctx.fillRect(Math.round(x - bodyW / 2), Math.round(y1), Math.max(1, Math.round(bodyW)), Math.max(1, Math.round(y2 - y1)));
    }
  }
  ctx.restore();
}
