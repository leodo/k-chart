/**
 * MOS 指标的离线校验：直接加载 frontend/js/indicators/mos.js（把 helpers.js 内联成 data URL），
 * 在真实 K 线上跑一遍，检查触发的标记是否合理，并单测通达信基础函数。
 *
 * 用法: node scripts/verify_mos.mjs [--period=1d] [--symbol=RBL9] [bars.json]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''));
const root = path.resolve(here, '..');
const argOf = (name, def) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};

async function loadBars() {
  const fileArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  if (fileArg) return JSON.parse(await readFile(path.resolve(root, fileArg), 'utf8'));
  const limit = Number(argOf('limit', 800));
  const url = `http://127.0.0.1:8765/api/bars?symbol=${argOf('symbol', 'RBL9')}&period=${argOf('period', '1d')}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`取 K 线失败 ${url} -> ${res.status}`);
  return (await res.json()).bars;
}

async function loadMOS() {
  const helpersSrc = await readFile(path.join(root, 'frontend/js/indicators/helpers.js'), 'utf8');
  const helpersUrl = 'data:text/javascript;base64,' + Buffer.from(helpersSrc).toString('base64');
  const mosSrc = (await readFile(path.join(root, 'frontend/js/indicators/mos.js'), 'utf8'))
    .replace("from './helpers.js'", `from '${helpersUrl}'`);
  return import('data:text/javascript;base64,' + Buffer.from(mosSrc).toString('base64'));
}

/* ---------- 1. 基础函数单测（通过导出的 computeMOS 间接覆盖） ---------- */
const mos = await loadMOS();

const synth = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
// 简单正弦行情：验证算法不崩、标记落在合法区间
const sineBars = synth(300, i => {
  const p = 100 + 10 * Math.sin(i / 12) + i * 0.05;
  return { time: String(i), open: p - 1, high: p + 2, low: p - 2, close: p, volume: 1 };
});
const sineOut = mos.computeMOS(sineBars, {});
let bad = 0;
if (sineOut.lines.length !== 10) { bad++; console.log('FAIL 均线族应有 10 条'); }
for (const line of sineOut.lines) {
  if (line.values.length !== sineBars.length) { bad++; console.log(`FAIL ${line.key} 长度不符`); }
}
for (const m of sineOut.markers) {
  if (!(m.i >= 0 && m.i < sineBars.length) || !Number.isFinite(m.price)) {
    bad++; console.log('FAIL 标记越界/价格非法', m);
  }
}
console.log(`正弦行情: lines=${sineOut.lines.length} markers=${sineOut.markers.length} ` +
  `(${['●底部结构', '●顶部结构', '时间', '▲低点', '▲高点'].map(t => `${t}:${sineOut.markers.filter(m => m.text === t).length}`).join(' ')})`);

/* ---------- 2. 真实行情 ---------- */
const raw = await loadBars();
const bars = raw.map(r => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
const t0 = performance.now();
const out = mos.computeMOS(bars, {});
const computeMs = performance.now() - t0;
const label = argOf('symbol', 'RBL9') + ' ' + argOf('period', '1d');

if (process.argv.includes('--json')) {
  const grouped = { bars: bars.length };
  for (const text of ['●底部结构', '●顶部结构', '时间', '▲低点', '▲高点']) {
    grouped[text] = out.markers.filter(m => m.text === text).map(m => m.i);
  }
  const outArg = process.argv.find(a => a.startsWith('--out='));
  const json = JSON.stringify(grouped);
  if (outArg) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.resolve(root, outArg.slice(6)), json, 'utf8');
  } else {
    console.log(json);
  }
  process.exit(0);
}

console.log(`\n=== ${label} bars=${bars.length} compute=${computeMs.toFixed(1)}ms ===`);
console.log(`markers=${out.markers.length}`);
for (const text of ['●底部结构', '●顶部结构', '时间', '▲低点', '▲高点']) {
  const hit = out.markers.filter(m => m.text === text);
  console.log(`  ${text}: ${hit.length}  ${hit.slice(-4).map(m => `#${m.i}`).join(' ')}`);
}

// 标记锚点：下方标记应正好等于该根 K 线的最低价，上方标记等于最高价
for (const m of out.markers) {
  const below = m.side === 'below';
  const base = below ? bars[m.i].low : bars[m.i].high;
  if (Math.abs(m.price - base) > 1e-6) { bad++; console.log('FAIL 标记锚点不是 K 线极值', m, base); }
}

// 「时间」标记来自两条各自 FILTER(·,13) 的序列（新高 / 新低），合在一起画，
// 所以只做频率上的合理性检查，不强制间隔 >= 14。
const timeCount = out.markers.filter(m => m.text === '时间').length;
const maxTimeCount = Math.ceil(bars.length / 13) * 2 + 2;
if (timeCount > maxTimeCount) { bad++; console.log(`FAIL 时间标记过多 ${timeCount} > ${maxTimeCount}`); }

// 参数开关：关掉结构 / 时间标记后，对应文字一条都不该出现
const noStruct = mos.computeMOS(bars, { struct: 0 });
const noTiming = mos.computeMOS(bars, { timing: 0 });
if (noStruct.markers.some(m => m.text.includes('结构'))) { bad++; console.log('FAIL struct=0 仍有结构标记'); }
if (noTiming.markers.some(m => ['时间', '▲低点', '▲高点'].includes(m.text))) { bad++; console.log('FAIL timing=0 仍有时间/高低点标记'); }

// 均线族的值应当有限且与收盘价同量级（EMA 链不会发散）
const last = bars.length - 1;
for (const line of out.lines) {
  const v = line.values[last];
  if (!Number.isFinite(v) || Math.abs(v - bars[last].close) > bars[last].close * 0.5) {
    bad++; console.log(`FAIL ${line.key} 末值异常 ${v}`);
  }
}

console.log(bad ? `\n${bad} 项异常` : '\nMOS 校验通过');
process.exit(bad ? 1 : 0);
