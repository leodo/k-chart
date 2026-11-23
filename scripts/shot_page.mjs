/** 通用页面截图：打开任意本地页面，收集 JS 错误并截图。 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const out = path.resolve(args.find(a => !a.startsWith('--')) || 'shot.png');
const opt = (name, def) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};
const url = opt('url', 'http://127.0.0.1:8765/');
const width = Number(opt('width', 1400));
const height = Number(opt('height', 900));
const port = Number(opt('port', 9341));
const waitMs = Number(opt('wait', 2500));
const click = opt('click', '');
const evalExpr = opt('eval', '');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = await mkdtemp(path.join(tmpdir(), 'kchart-page-'));
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', `--window-size=${width},${height}`, `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, url,
], { stdio: 'ignore', detached: false });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let target = null;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch { /* not ready */ }
}
if (!target) { child.kill(); throw new Error('CDP 没起来'); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
const errors = [];
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    errors.push(msg.params.entry.text);
  }
};
const send = (method, params = {}) => new Promise(res => {
  const id = ++seq;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
for (let i = 0; i < 60; i++) {
  if (await evaluate('document.readyState') === 'complete') break;
  await sleep(200);
}
await sleep(waitMs);
if (click) { await evaluate(`document.querySelector(${JSON.stringify(click)})?.click()`); await sleep(1800); }
const evaluated = evalExpr ? await evaluate(evalExpr) : null;
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await writeFile(out, Buffer.from(shot.result.data, 'base64'));
const info = await evaluate(`({title:document.title,text:(document.body.innerText||'').slice(0,500),rows:document.querySelectorAll('tbody tr').length})`);
console.log(JSON.stringify({ out, url, ...info, evaluated, errors }, null, 2));
child.kill();
ws.close();
