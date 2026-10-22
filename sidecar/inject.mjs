// Injects a small "Ctx used/limit (pct%)" text into the composer footer of every Antigravity chat page.
// Talks to the app's Chrome DevTools port (written to DevToolsActivePort). No app files are modified.
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const portFile = path.join(process.env.APPDATA, 'Antigravity', 'DevToolsActivePort');
// Single instance: exit if another injector already holds the lock port.
net.createServer().on('error', () => process.exit(0)).listen(47831, '127.0.0.1');
// Exit once the app has been unreachable for a while (started with a startup grace period).
let lastOk = Date.now() + 40000;
setInterval(() => { if (Date.now() - lastOk > 20000) process.exit(0); }, 5000);
const sessions = new Map(); // target id -> { ws, id, next }

const PAGE_JS = `(() => {
  if (window.__scInstalled) return; window.__scInstalled = true;
  window.__scState = { text: 'Ctx …', title: '', color: '' };
  const apply = () => {
    document.querySelectorAll('[class*="input-footer"][class*="justify-between"]').forEach(f => {
      let s = f.querySelector(':scope > #sc-ctx');
      if (!s) { s = document.createElement('span'); s.id = 'sc-ctx'; s.style.cssText = 'font-size:11px;opacity:.75;white-space:nowrap;padding:0 6px;cursor:default'; f.insertBefore(s, f.lastElementChild); }
      const st = window.__scState;
      if (s.textContent !== st.text) s.textContent = st.text;
      s.title = st.title; s.style.color = st.color;
    });
  };
  setInterval(apply, 500);
})()`;

function call(sess, method, params = {}) {
  return new Promise(res => {
    const id = sess.next++;
    const h = e => { const m = JSON.parse(e.data); if (m.id === id) { sess.ws.removeEventListener('message', h); res(m.result?.result?.value); } };
    sess.ws.addEventListener('message', h);
    sess.ws.send(JSON.stringify({ id, method, params }));
  });
}
const evalIn = (s, expression) => call(s, 'Runtime.evaluate', { expression, returnByValue: true });

function usage(cid) {
  return new Promise(res => execFile('python', ['-I', path.join(here, 'ctx.py'), ...(cid ? [cid] : [])], { timeout: 8000 },
    (e, out) => { try { res(JSON.parse(out)); } catch { res({}); } }));
}
const STATUS = { 3: 'Done / idle', 4: 'Invalid tool args', 5: 'Cancelled', 6: 'Waiting for approval/task', 7: 'Error' };

async function tick(sess) {
  const p = await evalIn(sess, 'location.pathname');
  const cid = /^\/c\/([\w-]+)/.exec(p || '')?.[1];
  if (!cid) return;
  const r = await usage(cid);
  let st;
  if (!r.used) st = { text: '', title: '', color: '' };
  else {
    const pct = Math.round(r.used / r.limit * 100), k = n => (n / 1000).toFixed(1) + 'k';
    st = { text: `Ctx ${k(r.used)}/${k(r.limit)} (${pct}%)`, title: `Last step: ${STATUS[r.status] || 'unknown'}`,
           color: pct >= 90 ? '#E06C75' : pct >= 70 ? '#E5C07B' : '' };
  }
  await evalIn(sess, `window.__scState = ${JSON.stringify(st)}`);
}

async function scan() {
  let port;
  try { port = readFileSync(portFile, 'utf8').split(/\r?\n/)[0]; } catch { return; }
  let list;
  try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { return; }
  lastOk = Date.now();
  const live = new Set();
  for (const t of list.filter(x => x.type === 'page')) {
    live.add(t.id);
    if (sessions.has(t.id)) continue;
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    const sess = { ws, next: 1 };
    sessions.set(t.id, sess);
    ws.onclose = () => sessions.delete(t.id);
    ws.onerror = () => sessions.delete(t.id);
    ws.onopen = async () => { await evalIn(sess, PAGE_JS); console.log('attached', t.id); };
  }
}

setInterval(scan, 3000);
setInterval(() => { for (const s of sessions.values()) if (s.ws.readyState === 1) tick(s).catch(() => {}); }, 3000);
scan();
console.log('show-context injector running');
