import { REGISTRY } from '../../indicators/registry.js';

/** 图例：开高低收靠右上，指标线与副图数值靠左上，末尾齿轮可打开指标设置。 */
export function drawLegend(ctx, g) {
  const idx = g.crosshair?.x != null
    ? Math.max(0, Math.min(g.bars.length - 1, Math.round(g.xToIndex(g.crosshair.x))))
    : g.bars.length - 1;
  const bar = g.bars[idx];
  if (!bar) return;

  ctx.save();
  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  ctx.textBaseline = 'middle';

  const diff = bar.close - bar.open;
  const pct = bar.open ? (diff / bar.open) * 100 : 0;
  const groups = [{ segs: [
    { text: `${g.symbol || ''} · ${g.period}  `, color: '#b9c6d6' },
    { text: `开 ${fmt(bar.open, g.priceDigits)}  `, color: '#b9c6d6' },
    { text: `高 ${fmt(bar.high, g.priceDigits)}  `, color: '#b9c6d6' },
    { text: `低 ${fmt(bar.low, g.priceDigits)}  `, color: '#b9c6d6' },
    { text: `收 ${fmt(bar.close, g.priceDigits)}  `, color: diff >= 0 ? g.colors.up : g.colors.down },
    { text: `${diff >= 0 ? '+' : ''}${pct.toFixed(2)}%  `, color: diff >= 0 ? g.colors.up : g.colors.down },
  ] }];

  for (const o of g.overlays || []) {
    const meta = REGISTRY[o.id];
    if (!meta) continue;
    const hidden = !!o.hidden;
    const segs = [{ text: `${meta.title(o.params)}${hidden ? '（隐藏）' : ''}  `, color: '#cbd6e4' }];
    if (!hidden) {
      const data = g.engine.get(o.id, g.bars, g.version, o.params);
      if (!data) continue;
      // 九转不画线：图例只显示当前 K 线落在结构里的数字（若有）。
      if (o.id === 'nine') {
        const mark = data.nineMarkers?.find(m => m.i === idx);
        if (mark) {
          segs.push({ text: ` ${mark.text}  `, color: o.style?.lineColors?.[mark.key] || mark.color });
        }
      }
      // 多支撑全部展开会撑爆图例：CH 只显示第 1 条支撑的数值，其余用数量表达；
      // MOS 有 10 条均线，只显示短期1 / 长期1 两条代表值。
      const legendLines = o.id === 'channel'
        ? data.lines.slice(0, 3)
        : o.id === 'mos'
          ? data.lines.filter(line => line.key === 's1' || line.key === 'l1')
          : data.lines;
      for (const line of legendLines) {
        if (o.style?.visible?.[line.key] === false) continue;
        const v = line.values[idx];
        if (Number.isFinite(v)) {
          segs.push({
            text: `${line.label} ${fmt(v, g.priceDigits)}  `,
            color: o.style?.lineColors?.[line.key] || line.color,
          });
        }
      }
    }
    groups.push({
      segs,
      eye: { kind: 'overlay', id: o.id, hidden },
      gear: { kind: 'overlay', id: o.id, indicator: o.id },
      // 支撑线专用步进器：+ 往前纳入更早一条，− 收掉最早一条。
      stepper: o.id === 'channel'
        ? { id: o.id, count: Number(o.params?.count) || 0 }
        : null,
    });
  }

  if (g.compare) {
    const v = g.compare.values[idx];
    if (Number.isFinite(v)) {
      groups.push({ segs: [{
        text: `  ${g.compare.symbol} ${v >= 0 ? '+' : ''}${v.toFixed(2)}%  `,
        color: g.compare.color,
      }] });
    }
  }

  // 开高低收 / 涨跌幅单独靠右上角；主图叠加指标仍从左往右排，避免长图例把价格挤走。
  const avail = g.width - g.right - g.left - 12;
  const x0 = g.left + 6;
  const y0 = g.main.top + 10;
  const priceWidth = paintRow(ctx, g, groups.slice(0, 1), x0, y0, avail, 'right');
  if (groups.length > 1) {
    paintRow(ctx, g, groups.slice(1), x0, y0, Math.max(80, avail - priceWidth - 10));
  }

  for (const pane of g.panes) {
    if (pane.kind !== 'indicator' || !pane.data) continue;
    const segs = [{ text: `${pane.title}${pane.empty ? '（无数据）' : ''} ▾  `, color: '#cbd6e4' }];
    for (const line of pane.data.lines) {
      if (pane.style?.visible?.[line.key] === false) continue;
      const v = line.values[idx];
      if (!Number.isFinite(v)) continue;
      let color = line.color;
      if (line.type === 'hist') color = pane.style?.histColors?.[line.key]?.up || line.color;
      else color = pane.style?.lineColors?.[line.key] || line.color;
      segs.push({ text: `${line.label} ${v.toFixed(2)}  `, color });
    }
    paintRow(ctx, g, [{
      segs,
      switcher: { id: pane.id },
      gear: { kind: 'pane', id: pane.id, indicator: pane.indicator },
    }], g.left + 6, pane.top + 10, g.width - g.right - g.left - 12);
  }
  ctx.restore();
}

/** 单行绘制：先量宽画底框，再逐段绘制，并在每组末尾登记齿轮命中区。align=right 时贴绘图区右缘。 */
function paintRow(ctx, g, groups, x, y, maxWidth, align = 'left') {
  if (!groups.length) return 0;
  let total = 0, controlWidth = 0;
  for (const grp of groups) {
    for (const seg of grp.segs) total += ctx.measureText(seg.text).width;
    if (grp.stepper) { total += 46; controlWidth += 46; }
    if (grp.eye) { total += 18; controlWidth += 18; }
    if (grp.switcher) { total += 18; controlWidth += 18; }
    if (grp.gear) { total += 20; controlWidth += 20; }
  }
  const boxW = Math.min(maxWidth, total + 12);
  if (boxW <= 0) return 0;
  const rectX = align === 'right' ? x + maxWidth - boxW : x - 4;
  const cx0 = rectX + 4;
  ctx.fillStyle = 'rgba(13,17,23,.78)';
  ctx.fillRect(rectX, y - 10, boxW, 20);

  let cx = cx0;
  const limit = rectX + boxW - 4;
  // 为 +/− 与齿轮预留宽度：文字放不下时跳过，按钮始终可见可点。
  const textLimit = Math.min(limit, cx0 + Math.max(0, maxWidth - 12 - controlWidth));
  for (const grp of groups) {
    for (const seg of grp.segs) {
      const w = ctx.measureText(seg.text).width;
      if (cx + w > textLimit) continue;
      ctx.fillStyle = seg.color;
      ctx.fillText(seg.text, cx, y);
      cx += w;
    }
    if (grp.stepper) {
      if (cx + 46 > limit) return boxW;
      const st = grp.stepper;
      const minusX = cx + 8, plusX = cx + 38;
      const hover = g.hoverStepper?.id === st.id;
      drawStepper(ctx, minusX, plusX, y, st.count, hover);
      g.stepperIcons?.push(
        { id: st.id, action: -1, x: minusX - 8, y: y - 9, w: 16, h: 18 },
        { id: st.id, action: 1, x: plusX - 8, y: y - 9, w: 16, h: 18 }
      );
      cx += 46;
    }
    if (grp.eye) {
      if (cx + 18 > limit) return boxW;
      const ex = cx + 9;
      const eye = grp.eye;
      const active = g.hoverEye?.kind === eye.kind && g.hoverEye?.id === eye.id;
      drawEye(ctx, ex, y, eye.hidden, active);
      g.eyeIcons?.push({ ...eye, x: ex - 9, y: y - 9, w: 18, h: 18 });
      cx += 18;
    }
    if (grp.switcher) {
      if (cx + 18 > limit) return boxW;
      const sx = cx + 9;
      const sw = grp.switcher;
      const active = g.hoverSwitch?.id === sw.id;
      drawSwitch(ctx, sx, y, active);
      g.switchIcons?.push({ ...sw, x: sx - 9, y: y - 9, w: 18, h: 18 });
      cx += 18;
    }
    if (grp.gear) {
      if (cx + 20 > limit) return boxW;
      const gx = cx + 10;
      const gear = grp.gear;
      const active = g.hoverSetting?.kind === gear.kind && g.hoverSetting?.id === gear.id;
      drawGear(ctx, gx, y, active);
      g.settingsIcons?.push({ ...gear, x: gx - 9, y: y - 9, w: 18, h: 18 });
      cx += 20;
    }
  }
  return boxW;
}

/** 支撑线步进器：−  [count]  +。 */
function drawStepper(ctx, minusX, plusX, cy, count, hover) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  ctx.strokeStyle = hover ? '#8cc1ff' : '#7d8b9c';
  ctx.fillStyle = hover ? '#8cc1ff' : '#b9c6d6';
  ctx.lineWidth = 1.1;
  for (const [x, sign] of [[minusX, '−'], [plusX, '+']]) {
    ctx.beginPath();
    ctx.arc(x, cy, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(sign, x, cy + 0.5);
  }
  ctx.fillStyle = '#d7e0ea';
  ctx.fillText(String(count), (minusX + plusX) / 2, cy + 0.5);
  ctx.restore();
}

/** 主图指标显隐开关：睁眼=显示，闭眼带斜线=已隐藏。 */
function drawEye(ctx, cx, cy, hidden, active) {
  ctx.save();
  ctx.strokeStyle = active ? '#8cc1ff' : '#7d8b9c';
  ctx.fillStyle = active ? '#8cc1ff' : '#b9c6d6';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.ellipse(cx, cy, 5.4, 3.3, 0, 0, Math.PI * 2);
  ctx.stroke();
  if (hidden) {
    ctx.beginPath();
    ctx.moveTo(cx - 6.5, cy + 5);
    ctx.lineTo(cx + 6.5, cy - 5);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, 1.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** 副图切换按钮：小圆圈 + 下拉箭头，点开可直接换指标。 */
function drawSwitch(ctx, cx, cy, active) {
  ctx.save();
  ctx.strokeStyle = active ? '#8cc1ff' : '#7d8b9c';
  ctx.fillStyle = active ? '#8cc1ff' : '#b9c6d6';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, 6.6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.font = '9px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('▾', cx, cy + 0.5);
  ctx.restore();
}

function drawGear(ctx, cx, cy, active) {
  ctx.save();
  ctx.strokeStyle = active ? '#8cc1ff' : '#7d8b9c';
  ctx.lineWidth = 1.15;
  ctx.beginPath();
  ctx.arc(cx, cy, 3.1, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 3.6, cy + Math.sin(a) * 3.6);
    ctx.lineTo(cx + Math.cos(a) * 5.1, cy + Math.sin(a) * 5.1);
    ctx.stroke();
  }
  ctx.restore();
}

function fmt(v, digits) { return Number.isFinite(v) ? v.toFixed(digits) : '-'; }
