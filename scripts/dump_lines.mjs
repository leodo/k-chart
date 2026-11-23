/**
 * 把 autoSupports 的计算结果导出成 JSON，供 scripts/render_check.py 画成 PNG 做人工比对。
 *
 * 用法: node scripts/dump_lines.mjs <bars.json|auto> <out.json> [count] [side] [visible]
 *       bars.json 不存在时自动从本地后端取（RBL9 / 日线）
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''));
const root = path.resolve(here, '..');
const [barsFile, outFile, countArg, sideArg, visibleArg] = process.argv.slice(2);
const count = Number(countArg || 1);
const side = Number(sideArg || 0);
const visible = Number(visibleArg || 130);

async function loadBars(file) {
  try { return JSON.parse(await readFile(path.resolve(root, file), 'utf8')); } catch {
    const res = await fetch('http://127.0.0.1:8765/api/bars?symbol=RBL9&period=1d&limit=800');
    if (!res.ok) throw new Error(`取 K 线失败 ${res.status}（后端没启动？先跑 start.bat）`);
    return (await res.json()).bars;
  }
}
const raw = await loadBars(barsFile);
const bars = raw.map(r => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
const src = await readFile(path.join(root, 'frontend/js/indicators/helpers.js'), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

const t0 = performance.now();
const r = mod.autoSupports(bars, {
  count, side, extend: 12, atrN: 14, zz: 2, tol: 0.45, minTouch: 3, breakout: 1, major: 1, majorLevel: 2,
});
const ms = performance.now() - t0;

const lines = [];
for (const s of r.supports) {
  for (const k of ['upper', 'lower', 'mid', 'single']) {
    const vals = s[k];
    if (!vals.some(Number.isFinite)) continue;
    lines.push({
      id: s.id, key: k, mode: s.mode, dir: s.dir, major: !!s.major,
      values: vals.map(v => (Number.isFinite(v) ? Number(v.toFixed(3)) : null)),
      touch: (s.touchPoints[k] || s.touchPoints.single || []).map(t => ({ i: t.i, v: Number(t.v.toFixed(3)) })),
    });
  }
}

await writeFile(path.resolve(root, outFile), JSON.stringify({
  symbol: 'RBL9', period: '1d', count, side, visible,
  ms: Number(ms.toFixed(1)),
  supports: r.supports.length,
  lines,
  bars,
}, null, 0), 'utf8');
console.log(`supports=${r.supports.length} lines=${lines.length} compute=${ms.toFixed(1)}ms -> ${outFile}`);
