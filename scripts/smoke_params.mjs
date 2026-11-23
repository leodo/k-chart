/**
 * 参数组合冒烟：自动线在极端/关闭类参数下不能崩，且仍满足「≥2 触点 / 长度受控」。
 *
 * 用法: node scripts/smoke_params.mjs [bars.json|--period=1h]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''));
const root = path.resolve(here, '..');
const periodArg = process.argv.find(a => a.startsWith('--period='));
const period = periodArg ? periodArg.split('=')[1] : '1d';
const fileArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
async function loadBars() {
  if (fileArg) return JSON.parse(await readFile(path.resolve(root, fileArg), 'utf8'));
  const res = await fetch(`http://127.0.0.1:8765/api/bars?symbol=RBL9&period=${period}&limit=800`);
  if (!res.ok) throw new Error(`取 K 线失败 ${res.status}（后端没启动？先跑 start.bat）`);
  return (await res.json()).bars;
}
const raw = await loadBars();
const bars = raw.map(r => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
const src = await readFile(path.join(root, 'frontend/js/indicators/helpers.js'), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

const touchAll = s => [].concat(s.touchPoints.upper || [], s.touchPoints.lower || [], s.touchPoints.single || []);
const span = v => {
  let from = -1, to = -1;
  for (let i = 0; i < v.length; i++) if (Number.isFinite(v[i])) { if (from < 0) from = i; to = i; }
  return { from, to };
};

const cases = [
  {}, { count: 0 }, { count: 1 }, { count: 12 }, { side: 1 }, { side: 2 }, { side: 3 },
  { major: 0 }, { breakout: 0 }, { major: 0, breakout: 0 }, { extend: 0 }, { extend: 50 },
  { n: 300 }, { atrN: 7, zz: 1, tol: 0.2, minTouch: 2 }, { majorLevel: 4 }, { majorLevel: 1 },
  { trend: 0 }, { trend: 0, major: 0, breakout: 0 }, { trend: 0, side: 2 },
  { side: 3, count: 12, major: 1, breakout: 1, extend: 50 },
];
let bad = 0;
for (const c of cases) {
  const p = { count: 2, side: 0, extend: 12, atrN: 14, zz: 2, tol: 0.45, minTouch: 3, breakout: 1, major: 1, majorLevel: 2, ...c };
  let r;
  try {
    r = mod.autoSupports(bars, p);
  } catch (err) {
    bad++; console.log(`  FAIL ${JSON.stringify(c)} 抛异常: ${err.message}`); continue;
  }
  let lines = 0, maxLen = 0, minTp = 99;
  for (const s of r.supports) {
    const tp = touchAll(s).map(t => t.i);
    minTp = Math.min(minTp, tp.length);
    for (const k of ['upper', 'lower', 'mid', 'single']) {
      const sp = span(s[k]);
      if (sp.from < 0) continue;
      lines++;
      maxLen = Math.max(maxLen, sp.to - sp.from + 1);
    }
  }
  const ok = r.supports.length === 0 || (minTp >= 2 && maxLen <= 500 + 8 + 50);
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${JSON.stringify(c).padEnd(58)} supports=${r.supports.length} lines=${lines} minTouch=${minTp} maxLen=${maxLen}`);
}
console.log(bad ? `\n${bad} 项异常` : '\n冒烟通过');
process.exit(bad ? 1 : 0);
