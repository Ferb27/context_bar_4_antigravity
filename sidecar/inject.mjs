// Shows context-window usage of the open conversation next to the Antigravity chat composer.
// Reads ~/.gemini/antigravity*/conversations/<id>.db (read-only) and injects UI through the app's
// Chrome DevTools port (written to DevToolsActivePort). No app files are modified.
import { readFileSync, statSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const portFile = path.join(process.env.APPDATA || '', 'Antigravity', 'DevToolsActivePort');
const convDirs = ['antigravity', 'antigravity-ide', 'antigravity-cli']
  .map(d => path.join(os.homedir(), '.gemini', d, 'conversations'));

// ---------- protobuf (schema-less) ----------
// gen_metadata layout (reverse-engineered): 1 -> 9 -> 10 { 1: used, 3: breakdown, 4: limit }, 1 -> 19: model.
function* fields(b) {
  let i = 0;
  const varint = () => { let r = 0, s = 1, c; do { c = b[i++]; r += (c & 0x7f) * s; s *= 128; } while (c & 0x80); return r; };
  while (i < b.length) {
    const k = varint(), f = Math.floor(k / 8), w = k % 8;
    if (w === 0) yield [f, varint()];
    else if (w === 2) { const l = varint(); yield [f, b.subarray(i, i + l)]; i += l; }
    else if (w === 1) i += 8;
    else if (w === 5) i += 4;
    else throw new Error('bad wire type');
    if (i > b.length) throw new Error('truncated');
  }
}
const get = (b, f) => { if (!b?.length) return; for (const [k, v] of fields(b)) if (k === f) return v; };
const all = (b, f) => { const o = []; if (b?.length) for (const [k, v] of fields(b)) if (k === f) o.push(v); return o; };
const str = v => (Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : '');

function parseGen(d) {
  try {
    const g1 = get(d, 1), g10 = get(get(g1, 9), 10);
    const used = get(g10, 1), limit = get(g10, 4);
    if (typeof used !== 'number' || typeof limit !== 'number' || !limit) return;
    const breakdown = all(get(g10, 3), 1).map(c => ({ name: str(get(c, 1)), tokens: get(c, 4) || 0 }));
    return { used, limit, breakdown, model: str(get(g1, 19)) };
  } catch { }
}

// First readable message inside an error_details blob.
function errorText(b) {
  if (!b?.length) return '';
  try {
    for (const [, v] of fields(b)) {
      if (typeof v === 'number') continue;
      const inner = errorText(v);
      if (inner) return inner;
      const s = str(v);
      if (s.length >= 8 && !/[\x00-\x08\x0e-\x1f�]/.test(s)) return s;
    }
  } catch { }
  return '';
}

// ---------- conversation reader (cached by file mtime) ----------
const cache = new Map(); // cid -> { key, data }
function findDb(cid) {
  for (const d of convDirs) { const p = path.join(d, cid + '.db'); if (existsSync(p)) return p; }
}
function fileKey(p) {
  const st = f => { try { const s = statSync(f); return s.mtimeMs + ':' + s.size; } catch { return '-'; } };
  return st(p) + '|' + st(p + '-wal');
}
function readConv(cid) {
  const p = findDb(cid);
  if (!p) return null;
  const key = fileKey(p), c = cache.get(cid);
  if (c?.key === key) return c.data;
  let db, data = null;
  try {
    db = new DatabaseSync(p, { readOnly: true });
    const gens = db.prepare('select data from gen_metadata order by idx desc limit 80').all()
      .map(r => parseGen(r.data)).filter(Boolean);
    if (gens.length) {
      const last = gens[0];
      // Average growth per model call over recent calls (drops = compaction, ignored).
      const hist = gens.map(g => g.used).reverse(), deltas = [];
      for (let i = 1; i < hist.length; i++) if (hist[i] > hist[i - 1]) deltas.push(hist[i] - hist[i - 1]);
      const recent = deltas.slice(-12), avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
      const step = db.prepare('select status, error_details from steps order by idx desc limit 1').get();
      const compactions = db.prepare('select count(*) n from steps where step_type = 23').get()?.n ?? 0;
      data = {
        ...last, compactions, history: hist.slice(-40),
        callsLeft: avg > 0 ? Math.max(0, Math.floor((last.limit - last.used) / avg)) : null,
        status: step?.status ?? null,
        error: step?.status === 7 ? errorText(step.error_details).slice(0, 300) : '',
      };
    }
  } catch (e) {
    data = c?.data ?? null; // keep last good value if the DB is busy
  } finally { try { db?.close(); } catch { } }
  cache.set(cid, { key, data });
  return data;
}

// ---------- page UI ----------
const CSS = `
    #sc-ctx { display: none !important; }
    #scx { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px;
      font-size: 11px; color: var(--muted-foreground, #888); cursor: pointer; white-space: nowrap; user-select: none;
      font-variant-numeric: tabular-nums; }
    #scx:hover, #scx.pinned { background: var(--card-border, rgba(255,255,255,.08)); color: var(--foreground, #ccc); }
    #scx .bar { width: 34px; height: 4px; border-radius: 2px; background: var(--card-border, rgba(255,255,255,.1)); overflow: hidden; }
    #scx .bar i { display: block; height: 100%; border-radius: 2px; transition: width .4s; }
    #scx .dot { width: 6px; height: 6px; border-radius: 50%; display: none; }
    @container input-footer (max-width: 420px) { #scx .txt { display: none; } }
    #scx-pop { position: fixed; z-index: 99999; width: 300px; padding: 12px 14px; border-radius: 12px; display: none;
      background: var(--background, #282c34); color: var(--foreground, #abb2bf); font-size: 12px; line-height: 1.45;
      border: 1px solid var(--card-border, rgba(255,255,255,.1)); box-shadow: 0 8px 28px rgba(0,0,0,.35);
      font-variant-numeric: tabular-nums; }
    #scx-pop .h { display: flex; justify-content: space-between; color: var(--muted-foreground, #888); font-size: 11px; }
    #scx-pop .big { font-size: 18px; margin: 4px 0 8px; color: var(--foreground); }
    #scx-pop .big small { font-size: 12px; color: var(--muted-foreground); }
    #scx-pop .stack { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--card-border); margin-bottom: 8px; }
    #scx-pop .row { display: flex; align-items: center; gap: 8px; }
    #scx-pop .row .sw { width: 8px; height: 8px; border-radius: 2px; flex: none; }
    #scx-pop .row .n { flex: 1; }
    #scx-pop .row .v { color: var(--muted-foreground); }
    #scx-pop .sep { border-top: 1px solid var(--card-border); margin: 8px 0; }
    #scx-pop .err { margin-top: 6px; padding: 6px 8px; border-radius: 6px; background: rgba(224,108,117,.12); color: #e06c75;
      word-break: break-word; max-height: 90px; overflow: auto; }
    #scx-pop svg { display: block; width: 100%; height: 28px; margin: 2px 0 6px; }
  `;

const PAGE_JS = String.raw`(() => {
  const VER = 2;
  if (window.__scxVer === VER) return;
  if (window.__scxTimer) clearInterval(window.__scxTimer);
  document.querySelectorAll('#scx, #scx-pop, #scx-style').forEach(e => e.remove());
  window.__scxVer = VER;
  const css = document.createElement('style'); css.id = 'scx-style';
  css.textContent = ${JSON.stringify(CSS)};
  document.head.appendChild(css);

  const COLORS = { 'System Prompt': '#c678dd', 'Tools': '#56b6c2', 'Chat Messages': 'var(--primary, #61afef)' };
  const STATUS = { 3: ['Done / idle', ''], 4: ['Invalid tool args', 'var(--warning, #e5c07b)'], 5: ['Cancelled', ''],
                   6: ['Waiting (approval / task)', 'var(--warning, #e5c07b)'], 7: ['Error', '#e06c75'] };
  const k = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : (n / 1000).toFixed(1) + 'k';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const level = p => p >= 90 ? '#e06c75' : p >= 70 ? 'var(--warning, #e5c07b)' : 'var(--primary, #61afef)';

  const pop = document.createElement('div'); pop.id = 'scx-pop'; document.body.appendChild(pop);
  let pinned = false, hover = false, json = '', state = null;

  function spark(h, limit) {
    if (!h || h.length < 2) return '';
    const W = 272, H = 28, x = i => (i / (h.length - 1)) * W, y = v => H - 2 - (v / limit) * (H - 4);
    const pts = h.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none"><line x1="0" x2="' + W + '" y1="' + y(limit) +
      '" y2="' + y(limit) + '" stroke="var(--card-border)" stroke-dasharray="3 3"/><polyline points="' + pts +
      '" fill="none" stroke="var(--primary, #61afef)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>';
  }

  function renderPop() {
    const s = state; if (!s) return;
    const pct = s.used / s.limit * 100, left = s.limit - s.used;
    const total = s.breakdown.reduce((a, b) => a + b.tokens, 0) || s.used;
    const st = STATUS[s.status] || ['Unknown', ''];
    pop.innerHTML =
      '<div class="h"><span>Context window</span><span>' + esc(s.model || '') + '</span></div>' +
      '<div class="big">' + k(s.used) + ' <small>/ ' + k(s.limit) + ' · ' + pct.toFixed(1) + '%</small></div>' +
      '<div class="stack">' + s.breakdown.map(b => '<i style="width:' + (b.tokens / s.limit * 100) + '%;background:' +
        (COLORS[b.name] || '#98c379') + '"></i>').join('') + '</div>' +
      s.breakdown.map(b => '<div class="row"><span class="sw" style="background:' + (COLORS[b.name] || '#98c379') +
        '"></span><span class="n">' + esc(b.name) + '</span><span class="v">' + k(b.tokens) + ' · ' +
        Math.round(b.tokens / total * 100) + '%</span></div>').join('') +
      '<div class="row"><span class="sw" style="background:var(--card-border)"></span><span class="n">Free</span><span class="v">' +
        k(left) + '</span></div>' +
      '<div class="sep"></div>' + spark(s.history, s.limit) +
      (s.callsLeft != null ? '<div class="row"><span class="n">Est. model calls left</span><span class="v">~' + s.callsLeft + '</span></div>' : '') +
      '<div class="row"><span class="n">Compactions</span><span class="v">' + s.compactions + '</span></div>' +
      '<div class="row"><span class="n">Last step</span><span class="v" style="color:' + (st[1] || 'inherit') + '">' + st[0] + '</span></div>' +
      (s.error ? '<div class="err">' + esc(s.error) + '</div>' : '');
  }

  function place(anchor) {
    const r = anchor.getBoundingClientRect();
    pop.style.display = 'block';
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(innerWidth - pw - 8, r.left + r.width / 2 - pw / 2)) + 'px';
    pop.style.top = Math.max(8, r.top - ph - 8) + 'px';
  }
  const sync = () => {
    const a = document.getElementById('scx');
    if (a && state && (pinned || hover)) { renderPop(); place(a); } else pop.style.display = 'none';
    a?.classList.toggle('pinned', pinned);
  };
  document.addEventListener('mousedown', e => {
    if (pinned && !e.target.closest('#scx, #scx-pop')) { pinned = false; sync(); }
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && pinned) { pinned = false; sync(); } });

  function ensure() {
    const f = document.querySelector('[class*="input-footer"][class*="justify-between"]');
    let el = document.getElementById('scx');
    if (!state || !f) { if (el) el.remove(); if (!state) { pop.style.display = 'none'; } return; }
    if (!el || el.parentElement !== f) {
      el?.remove();
      el = document.createElement('div'); el.id = 'scx';
      el.innerHTML = '<span class="dot"></span><span class="bar"><i></i></span><span class="txt"></span>';
      el.addEventListener('mouseenter', () => { hover = true; sync(); });
      el.addEventListener('mouseleave', () => { hover = false; sync(); });
      el.addEventListener('click', e => { e.stopPropagation(); pinned = !pinned; sync(); });
      f.insertBefore(el, f.lastElementChild);
    }
    const pct = state.used / state.limit * 100, st = STATUS[state.status];
    el.querySelector('.bar i').style.cssText = 'width:' + Math.min(100, pct) + '%;background:' + level(pct);
    el.querySelector('.txt').textContent = Math.round(pct) + '% · ' + k(state.used);
    const dot = el.querySelector('.dot');
    dot.style.display = st && st[1] ? 'block' : 'none'; if (st) dot.style.background = st[1];
    el.style.color = pct >= 90 ? '#e06c75' : '';
    el.title = '';
  }

  window.__scxSet = j => {
    if (j === json) return; json = j; state = j ? JSON.parse(j) : null;
    ensure(); if (pop.style.display === 'block') sync();
  };
  window.__scxTimer = setInterval(ensure, 700);
})()`;

// ---------- DevTools plumbing ----------
// Single instance: exit if another injector already holds the lock port.
net.createServer().on('error', () => process.exit(0)).listen(47831, '127.0.0.1');
// Exit once the app has been unreachable for a while (with a startup grace period).
let lastOk = Date.now() + 40000;
setInterval(() => { if (Date.now() - lastOk > 20000) process.exit(0); }, 5000);

const sessions = new Map(); // target id -> { ws, next }
function call(sess, method, params = {}) {
  return new Promise(res => {
    const id = sess.next++;
    const h = e => { const m = JSON.parse(e.data); if (m.id === id) { sess.ws.removeEventListener('message', h); res(m.result?.result?.value); } };
    sess.ws.addEventListener('message', h);
    sess.ws.send(JSON.stringify({ id, method, params }));
  });
}
const evalIn = (s, expression) => call(s, 'Runtime.evaluate', { expression, returnByValue: true });

async function tick(sess) {
  const p = await evalIn(sess, 'location.pathname');
  const cid = /^\/c\/([\w-]+)/.exec(p || '')?.[1];
  const data = cid ? readConv(cid) : null;
  // PAGE_JS is idempotent, so re-sending it also covers page reloads.
  await evalIn(sess, `${PAGE_JS}; window.__scxSet(${JSON.stringify(data ? JSON.stringify(data) : '')})`);
}

async function scan() {
  let port, list;
  try { port = readFileSync(portFile, 'utf8').split(/\r?\n/)[0]; } catch { return; }
  try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { return; }
  lastOk = Date.now();
  for (const t of list.filter(x => x.type === 'page')) {
    if (sessions.has(t.id)) continue;
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    const sess = { ws, next: 1 };
    sessions.set(t.id, sess);
    ws.onclose = ws.onerror = () => sessions.delete(t.id);
    ws.onopen = () => { console.log('attached', t.id); tick(sess).catch(() => { }); };
  }
}

setInterval(scan, 3000);
setInterval(() => { for (const s of sessions.values()) if (s.ws.readyState === 1) tick(s).catch(() => { }); }, 2000);
scan();
console.log('show-context injector running');
