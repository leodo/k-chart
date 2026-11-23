/**
 * 自动支撑/压力/通道线的不变量回归（Node ESM，直接吃 frontend/js/indicators/helpers.js）。
 *
 * 用法:
 *   node scripts/verify_channel.mjs                 # 默认从本地后端取 RBL9 / 日线
 *   node scripts/verify_channel.mjs bars.json       # 或指定 scripts/dump_bars.py 导出的 JSON
 *   node scripts/verify_channel.mjs --symbol=RBL9 --period=1h
 *   node scripts/verify_channel.mjs --all           # 跑 scripts/bars_*.json 全部数据集（若存在）
 *
 * 断言（对应本次报修）:
 *   A. 每条线至少 2 个触点，且触点跨度 ≥ 10 根 —— 不再出现「只穿过一个点」的线；
 *   B. 绘制长度 = 触点跨度 + 外推（≤ span + extBefore + extend），不再横穿整张图；
 *   C. count 从小到大是稳定的前缀：+ 只追加更靠历史的线，− 只收掉最早的一条。
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''));
const root = path.resolve(here, '..');
const EXTEND = 12;
const EXT_BEFORE = Math.min(8, Math.round(EXTEND / 2));
const MIN_SPAN = 10;

const src = await readFile(path.join(root, 'frontend/js/indicators/helpers.js'), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { autoSupports } = mod;

let failures = 0;
const fail = msg => { failures++; console.log(`  FAIL ${msg}`); };

const argOf = (name, def) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
async function loadBars(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    const symbol = argOf('symbol', 'RBL9');
    const period = argOf('period', '1d');
    const url = `http://127.0.0.1:8765/api/bars?symbol=${encodeURIComponent(symbol)}&period=${period}&limit=800`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`取 K 线失败: ${url} -> ${res.status}（后端没启动？先跑 start.bat）`);
    return (await res.json()).bars;
  }
}

const all = process.argv.includes('--all');
const fileArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const barsFiles = all
  ? (await readdir(here)).filter(f => /^bars_.*\.json$/.test(f)).map(f => path.join(here, f))
  : [fileArg ? path.resolve(root, fileArg) : path.join(here, 'bars_default.json')];

const touchAll = s => [].concat(s.touchPoints.upper || [], s.touchPoints.lower || [], s.touchPoints.single || []);
function span(values) {
  let from = -1, to = -1;
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) { if (from < 0) from = i; to = i; }
  }
  return { from, to, width: to - from + 1 };
}
const lineKey = s => {
  const mode = s.mode;
  const line = mode === 'channel' ? (s.prim === 'lower' ? s.lower : s.upper) : s.single;
  const sp = span(line);
  const first = sp.from >= 0 ? line[sp.from] : 0;
  const slope = sp.to > sp.from ? (line[sp.to] - line[sp.from]) / (sp.to - sp.from) : 0;
  return `${mode}|${s.prim}|${s.start}|${s.end}|${sp.from}|${sp.to}|${first.toFixed(2)}|${slope.toFixed(4)}`;
};

for (const file of barsFiles) {
  const raw = await loadBars(file);
  const bars = raw.map(r => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
  const len = bars.length;
  if (len < 60) { console.log(`\n${path.basename(file)}: 数据太少 (${len})，跳过`); continue; }
  const label = fileArg || all ? path.basename(file) : `${argOf('symbol', 'RBL9')} ${argOf('period', '1d')}（后端 API）`;
  console.log(`\n=== ${label} bars=${len} last=${bars[len - 1].time} ===`);

  for (const side of [0, 1, 2, 3]) {
    const runs = [];
    for (const count of [1, 2, 3, 4, 6, 8, 12]) {
      const p = { count, side, extend: EXTEND, atrN: 14, zz: 2, tol: 0.45, minTouch: 3, breakout: 1, major: 1, majorLevel: 2 };
      const r = autoSupports(bars, p);
      runs.push({ count, supports: r.supports });
      r.supports.forEach((s, idx) => {
        const tp = touchAll(s);
        const ids = tp.map(t => t.i).sort((a, b) => a - b);
        const touchSpan = ids.length ? ids[ids.length - 1] - ids[0] : 0;
        if (ids.length < 2) fail(`side=${side} count=${count} #${idx} 只有 ${ids.length} 个触点`);
        else if (touchSpan < MIN_SPAN) fail(`side=${side} count=${count} #${idx} 触点跨度只有 ${touchSpan} 根`);
        // 每条轨的绘制长度
        for (const k of ['upper', 'lower', 'single']) {
          const sp = span(s[k]);
          if (sp.from < 0) continue;
          const width = sp.to - sp.from + 1;
          if (width > touchSpan + EXT_BEFORE + EXTEND + 2) {
            fail(`side=${side} count=${count} #${idx} ${k} 画了 ${width} 根 (触点跨度 ${touchSpan})`);
          }
          if (sp.to > len - 1 + EXTEND) {
            fail(`side=${side} count=${count} #${idx} ${k} 画过最新 K 线 ${sp.to - (len - 1)} 根（上限 ${EXTEND}）`);
          }
        }
      });
    }

    // C. 前缀关系：count 增大只能追加，不能改动/重排已画的线
    for (let i = 1; i < runs.length; i++) {
      const a = runs[i - 1], b = runs[i];
      const ka = a.supports.map(lineKey);
      const kb = b.supports.map(lineKey);
      const samePrefix = ka.every((k, j) => kb[j] === k);
      if (!samePrefix) {
        const at = ka.findIndex((k, j) => kb[j] !== k);
        fail(`side=${side} count ${a.count}->${b.count} 不是稳定前缀（第 ${at} 条起被改动或重排）`);
        console.log('    A', ka.slice(at, at + 3));
        console.log('    B', kb.slice(at, at + 3));
      }
      if (kb.length < ka.length) fail(`side=${side} count ${a.count}->${b.count} 线反而变少了`);
      // 追加的线必须是「更早」的：不能比已有线更靠右
      const maxLast = Math.max(...a.supports.map(s => Math.max(...touchAll(s).map(t => t.i))), -1);
      const added = b.supports.slice(ka.length);
      const newer = added.filter(s => Math.max(...touchAll(s).map(t => t.i)) > maxLast);
      if (newer.length) fail(`side=${side} count ${a.count}->${b.count} 追加的 ${newer.length} 条比已有线更靠近最新`);
    }

    const summary = runs.map(r => `${r.count}:${r.supports.length}`).join(' ');
    console.log(`  side=${side} 条数(请求:实际) ${summary}`);
  }
}

console.log(failures ? `\n${failures} 项不满足` : '\n全部不变量通过');
process.exit(failures ? 1 : 0);
