/** 网格 + 坐标轴：所有面板共用横向网格，各自绘制纵向刻度。 */
export function drawGrid(ctx, g) {
  const { left, right, width, height, panes, timeH, timeAxisY, bars, start, end, barWidth } = g;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
  ctx.textBaseline = 'middle';

  // 面板底与横向刻度。相邻面板只隔 6px，跳过上方面板的底标签，避免轴文字叠在一起。
  for (let pi = 0; pi < panes.length; pi++) {
    const p = panes[pi];
    const lastTick = pi === panes.length - 1 ? 4 : 3;
    ctx.fillStyle = '#101722';
    ctx.fillRect(left, p.top, width - left - right, p.height);
    ctx.strokeStyle = g.colors.grid;
    for (let i = 0; i <= lastTick; i++) {
      const y = Math.round(p.top + (p.height * i) / 4) + 0.5;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke();
      const value = p.yToPrice(y);
      ctx.fillStyle = g.colors.axis;
      ctx.fillText(formatPaneValue(value, p, g), width - right + 7, y);
    }
    ctx.strokeStyle = '#1e2936';
    ctx.beginPath(); ctx.moveTo(left, Math.round(p.bottom) + 0.5); ctx.lineTo(width - right, Math.round(p.bottom) + 0.5); ctx.stroke();
  }

  // 时间竖线：按可见 K 线数自适应间隔
  const rough = Math.ceil(90 / barWidth);
  const pow = 10 ** Math.floor(Math.log10(Math.max(1, rough)));
  const step = [1, 2, 5, 10].map(v => v * pow).find(v => v >= rough) || pow * 10;
  ctx.strokeStyle = g.colors.grid;
  ctx.fillStyle = g.colors.axis;
  for (let i = Math.ceil(start / step) * step; i <= end; i += step) {
    const bar = bars[i];
    if (!bar) continue;
    const x = Math.round(g.indexToX(i)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, panes[0].top); ctx.lineTo(x, timeAxisY); ctx.stroke();
    ctx.fillText(shortTime(bar.time, g.period), x + 4, timeAxisY + 12);
  }

  // 右侧价格轴与底部时间轴分隔线
  ctx.strokeStyle = '#2b3745';
  ctx.beginPath(); ctx.moveTo(width - right + 0.5, 0); ctx.lineTo(width - right + 0.5, height); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, timeAxisY + 0.5); ctx.lineTo(width, timeAxisY + 0.5); ctx.stroke();
  ctx.restore();
}

function formatPaneValue(v, pane, g) {
  if (pane.indicator === 'volume') return shortNum(v);
  if (['kdj', 'rsi', 'dmi', 'wr', 'cci'].includes(pane.indicator)) return v.toFixed(1);
  if (pane.indicator === 'obv') return shortNum(v);
  if (pane.kind === 'price') return v.toFixed(g.priceDigits);
  return v.toFixed(Math.abs(v) >= 100 ? 1 : 3);
}

export function shortNum(v) {
  const a = Math.abs(v);
  if (a >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (a >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return Math.round(v).toString();
}

function shortTime(time, period) {
  if (period === '1d') return time.slice(2, 10);
  if (period === '4h' || period === '1h') return time.slice(5, 16);
  return time.slice(5, 16);
}
