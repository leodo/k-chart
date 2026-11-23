/** 隐波叠加线：独立纵轴，按主图高度等比例映射，不参与价格轴自动范围。 */
export function drawVix(ctx, g) {
  const v = g.vix;
  if (!v?.values?.length) return;
  const main = g.main;
  const left = g.left;
  const right = g.width - g.right;
  const color = v.color || '#b57bff';

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, main.top, Math.max(1, right - left), Math.max(1, main.height));
  ctx.clip();
  ctx.beginPath();
  let started = false;
  for (let i = g.start; i <= g.end; i++) {
    const value = v.values[i];
    if (!Number.isFinite(value)) { started = false; continue; }
    const x = g.indexToX(i);
    const y = v.toY(value);
    if (started) ctx.lineTo(x, y);
    else { ctx.moveTo(x, y); started = true; }
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.7;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = color;
  for (let i = 0; i <= 3; i++) {
    const value = v.hi - (v.hi - v.lo) * i / 3;
    ctx.fillText(value.toFixed(1), right + 5, v.toY(value));
  }
  const idx = g.crosshair?.x != null
    ? Math.max(0, Math.min(v.values.length - 1, Math.round(g.xToIndex(g.crosshair.x))))
    : g.end;
  const current = v.values[idx];
  if (Number.isFinite(current)) {
    const label = `隐波 ${current.toFixed(2)}`;
    const w = ctx.measureText(label).width + 10;
    // 右上角让给开高低收，隐波数值排在它下面一行。
    ctx.fillStyle = 'rgba(13,17,23,.86)';
    ctx.fillRect(right - w - 6, main.top + 26, w, 17);
    ctx.fillStyle = color;
    ctx.fillText(label, right - w - 1, main.top + 34.5);
  }
  ctx.restore();
}
