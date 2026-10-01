#!/usr/bin/env node
// Comment Desk (the dev-comments skill's /comments): one local page where the owner answers comments from every
// source of a project (local dev comments, a staging site's comments) and works with Claude on each one, plus the
// CLI Claude uses on the other end. Node only, no dependencies, bound to 127.0.0.1.
//
//   node desk.mjs serve                     the page on http://127.0.0.1:<port> (config "port", default 4390)
//   node desk.mjs wait                      block until the owner writes in a workbench; print it and exit
//                                           (Claude runs it in the background: the exit wakes the session)
//   node desk.mjs pending                   the owner's messages Claude has not answered
//   node desk.mjs say <src> <id> "text" [--img file]… [--lane dev|staging|waiting|new]   answer in a card's workbench
//   node desk.mjs note <src> <id> <lane> "text"   the card's "where it stands" line + lane
//   node desk.mjs clear <src> <id>          drop the note
//   node desk.mjs feed "text"               a line in the Claude column
//   node desk.mjs show                      print the desk state
//
// Config: .comment-desk.json at the project root (found from the current folder upwards):
//   { "port": 4390, "me": "Noor", "state": ".comment-desk",
//     "sources": [
//       { "id": "local", "label": "Mine · localhost", "kind": "file", "dir": ".dev-comments", "site": "http://localhost:5173" },
//       { "id": "staging", "label": "Tobias · staging", "kind": "http", "audience": "Tobias",
//         "endpoint": "https://staging.bluefinch.example/wp-json/dev-comments/v1/comments", "authFile": ".staging-login.txt",
//         "site": "https://staging.bluefinch.example", "shots": ".dev-comments/shots", "room": "On staging · Tobias sees this" } ] }
// kind "file": a dev-comments store folder (comments.json); kind "http": a dev-comments endpoint (GET = the store,
// PATCH /<id> = reply / status), with HTTP basic auth read from authFile ("user:pass" or "…: user / pass"), OR a
// sign-in for sites whose endpoint takes a session token (e.g. Payload CMS):
//   "login": { "url": "https://test.bluefinch.example/api/users/login", "envFile": ".env.local",
//              "user": "NOTES_EMAIL", "password": "NOTES_PASSWORD", "scheme": "JWT" }
// posts {email, password} from those env-file variables, reads `token` from the answer and sends
// "Authorization: <scheme> <token>"; signs in again once when the token expires (a 401).
// A source with an "audience" is public: the people named there read its threads, so the page draws them as theirs
// and previews every reply. "room" (optional) is the label over a thread. Workbench chat, notes and pasted images stay in the "state" folder (git-ignore it).
//
// A hosted desk (a hidden copy on the staging site, e.g. examples/hosted-desk/wordpress/) keeps the workbench chat,
// notes and feed in a SHARED STORE on the server, so the Mac desk and the phone show the same thing. Point the Mac
// at it in .comment-desk.local.json (git-ignored, merged over .comment-desk.json):
//   { "remote": { "url": "https://staging.bluefinch.example/<hidden path>", "authFile": ".staging-login.txt",
//                 "tokenKeychain": "comment-desk-token:<project>" } }
// The tools' token is read from the macOS Keychain (that service) or the env var COMMENT_DESK_TOKEN; never a file.
//
// TRUST (a hosted desk means a door from the internet into this session): Claude acts on a workbench message only
// when THIS Mac says so: it was typed on this Mac's desk, or the owner approved it on Telegram (a reply "ok" to the
// question `wait` sent, or "ok" / "ok 1 3" to a "pending" list; only replies count; his own chat, within 7 days,
// the exact text). The
// approvals are recorded by tg-listener.mjs (one listener for every project, always running). That list lives on the Mac
// (<state>/trusted.json); whatever the server's store says never counts, so a message written into it by the hosted
// page, or by anyone who got into the hosting, is only ever a question to the owner. Needs the Telegram bot of the
// comment watch (Keychain "dev-comments-telegram", watch.telegram.chatId).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { store as fileStore, patchComment } from '../store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANES = ['new', 'claude', 'dev', 'staging', 'waiting'];

// ---------- config
function findRoot(dir = process.cwd()) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.comment-desk.json'))) return d;
    if (path.dirname(d) === d) return null;
  }
}
const ROOT = findRoot();
if (!ROOT) { console.error('No .comment-desk.json in this folder or above it (see the dev-comments skill, Comment Desk).'); process.exit(1); }
const CFG = Object.assign(JSON.parse(fs.readFileSync(path.join(ROOT, '.comment-desk.json'), 'utf8')),
  fs.existsSync(path.join(ROOT, '.comment-desk.local.json')) ? JSON.parse(fs.readFileSync(path.join(ROOT, '.comment-desk.local.json'), 'utf8')) : {});
const ME = CFG.me || 'you';
const STATE_DIR = path.resolve(ROOT, CFG.state || '.comment-desk');
const STATE = path.join(STATE_DIR, 'state.json');
const UPLOADS = path.join(STATE_DIR, 'uploads');
const LOCK = path.join(STATE_DIR, '.lock');
const SOURCES = (CFG.sources || []).map((s) => ({ ...s, shots: path.resolve(ROOT, s.shots || path.join(s.dir || '.dev-comments', 'shots')) }));
const source = (id) => SOURCES.find((s) => s.id === id);
const PORT = Number(CFG.port || 4390);

// ---------- desk state (notes, feed, workbench chat), shared by the server and the CLI under a lock
const empty = () => ({ notes: {}, feed: [], chat: {}, nextMsg: 1 });
function read() { try { return Object.assign(empty(), JSON.parse(fs.readFileSync(STATE, 'utf8'))); } catch { return empty(); } }
function update(fn) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  let ok = false;
  for (let i = 0; i < 200 && !ok; i++) {
    try { fs.mkdirSync(LOCK); ok = true; } catch {
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 10000) fs.rmSync(LOCK, { recursive: true, force: true }); } catch {}
      const t = Date.now() + 25; while (Date.now() < t) { /* wait */ }
    }
  }
  if (!ok) throw new Error('desk state is locked');
  try {
    const s = read(); const out = fn(s);
    fs.writeFileSync(STATE + '.tmp', JSON.stringify(s, null, 2) + '\n'); fs.renameSync(STATE + '.tmp', STATE);
    return out;
  } finally { fs.rmSync(LOCK, { recursive: true, force: true }); }
}
function addMessage(s, src, id, by, text, images = []) {
  const k = `${src}:${id}`;
  const m = { id: s.nextMsg++, by, text: String(text || '').slice(0, 8000), images, at: new Date().toISOString() };
  if (by !== 'Claude') m.status = 'new';
  else for (const x of s.chat[k] || []) if (x.by !== 'Claude' && x.status !== 'answered') x.status = 'answered';
  (s.chat[k] ||= []).push(m);
  return m;
}
const setNote = (s, src, id, patch) => { (s.notes[src] ||= {})[id] = Object.assign({}, s.notes[src][id], patch); };
const answerAll = (s, src, id) => { for (const m of s.chat[`${src}:${id}`] || []) if (m.by !== 'Claude' && m.status !== 'answered') m.status = 'answered'; };
function saveImages(dataUrls) {
  fs.mkdirSync(UPLOADS, { recursive: true });
  const out = [];
  for (const d of (dataUrls || []).slice(0, 8)) {
    const mm = /^data:image\/(png|jpeg|webp|gif);base64,(.+)$/.exec(String(d)); if (!mm) continue;
    const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${mm[1] === 'jpeg' ? 'jpg' : mm[1]}`;
    fs.writeFileSync(path.join(UPLOADS, name), Buffer.from(mm[2], 'base64')); out.push(name);
  }
  return out;
}
const msgHash = (m) => crypto.createHash('sha256').update(`${m.id}\n${m.text || ''}\n${(m.images || []).join(',')}`).digest('hex');
const TRUST = path.join(STATE_DIR, 'trusted.json');
const trusted = () => { try { return new Set(JSON.parse(fs.readFileSync(TRUST, 'utf8'))); } catch { return new Set(); } };
const trust = (m) => { const t = trusted(); t.add(msgHash(m)); fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(TRUST, JSON.stringify([...t].slice(-2000))); };
const toDataUrl = (f) => `data:image/${({ jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', gif: 'gif' })[path.extname(f).slice(1).toLowerCase()] || 'png'};base64,${fs.readFileSync(f).toString('base64')}`;

// ---------- where the desk state lives: this Mac (the state file) or the hosted desk's shared store (remote)
const REMOTE = CFG.remote && CFG.remote.url ? { ...CFG.remote, url: CFG.remote.url.replace(/\/$/, '') } : null;
function deskToken() {
  if (process.env.COMMENT_DESK_TOKEN) return process.env.COMMENT_DESK_TOKEN;
  try { return execFileSync('security', ['find-generic-password', '-s', REMOTE.tokenKeychain, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { throw new Error(`no desk token: Keychain service "${REMOTE.tokenKeychain}" or COMMENT_DESK_TOKEN`); }
}
async function deskCall(p, body) {
  const headers = { 'x-desk-token': deskToken(), ...(REMOTE.authFile ? { authorization: basicAuth(REMOTE.authFile) } : {}) };
  const r = await fetch(REMOTE.url + p, body === undefined ? { headers } : { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`hosted desk answered ${r.status} for ${p}`);
  return r;
}
const store = REMOTE ? {
  get: async () => (await deskCall('/api/desk')).json(),
  chat: async (src, id, by, text, dataUrls) => (await deskCall(`/api/chat/${src}/${id}`, { by, text, images: dataUrls || [] })).json(),
  note: async (src, id, lane, text) => (await deskCall('/api/desk/note', { src, id, lane, text, answer: true })).json(),
  clear: async (src, id) => (await deskCall('/api/desk/note', { src, id, clear: true })).json(),
  feed: async (lines) => (await deskCall('/api/desk/feed', { lines })).json(),
  seen: async (ids) => (await deskCall('/api/desk/seen', { ids })).json(),
  image: async (name) => {   // pasted images live on the server; keep a local copy so Claude can look at them
    const f = path.join(UPLOADS, name);
    if (!fs.existsSync(f)) { fs.mkdirSync(UPLOADS, { recursive: true }); fs.writeFileSync(f, Buffer.from(await (await deskCall('/upload/' + name)).arrayBuffer())); }
    return f;
  },
} : {
  get: async () => read(),
  chat: async (src, id, by, text, dataUrls) => { const images = saveImages(dataUrls); return update((s) => { const m = addMessage(s, src, id, by, text, images); if (by !== 'Claude') setNote(s, src, id, { lane: 'claude', at: m.at }); return m; }); },
  note: async (src, id, lane, text) => update((s) => { setNote(s, src, id, { lane, ...(text ? { text } : {}), at: new Date().toISOString() }); answerAll(s, src, id); }),
  clear: async (src, id) => update((s) => { delete (s.notes[src] || {})[id]; }),
  feed: async (lines) => update((s) => { for (const t of lines) s.feed.push({ at: new Date().toISOString(), text: t }); s.feed = s.feed.slice(-200); }),
  seen: async (ids) => update((s) => { for (const { m } of unanswered(s)) if (ids.includes(m.id)) m.status = 'seen'; }),
  image: async (name) => path.join(UPLOADS, name),
};

// ---------- sources
function basicAuth(file) {
  const t = fs.readFileSync(path.resolve(ROOT, file), 'utf8').trim();
  const m = /(\S+)\s*\/\s*(\S+)\s*$/.exec(t) || /^([^:\s]+):(\S+)$/.exec(t);
  if (!m) throw new Error(`cannot read a login from ${file}`);
  return 'Basic ' + Buffer.from(m[1] + ':' + m[2]).toString('base64');
}
function envValue(file, name) {
  const t = fs.readFileSync(path.resolve(ROOT, file), 'utf8');
  const m = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`, 'm').exec(t);
  if (!m) throw new Error(`${name} is not set in ${file}`);
  return m[1].trim().replace(/^["']|["']$/g, '');
}
const tokens = new Map();
async function signIn(src) {
  const l = src.login;
  const r = await fetch(l.url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: envValue(l.envFile, l.user), password: envValue(l.envFile, l.password) }) });
  if (!r.ok) throw new Error(`${src.label}: sign-in answered ${r.status}`);
  const token = (await r.json()).token;
  if (!token) throw new Error(`${src.label}: sign-in returned no token`);
  tokens.set(src.id, token);
  return token;
}
async function authHeaders(src, again = false) {
  if (src.authFile) return { authorization: basicAuth(src.authFile) };
  if (!src.login) return {};
  const token = (!again && tokens.get(src.id)) || (await signIn(src));
  return { authorization: `${src.login.scheme || 'JWT'} ${token}` };
}
/** fetch with the source's auth; a signed-in source signs in once more on a 401. */
async function remote(src, url, init = {}) {
  let r = await fetch(url, { ...init, headers: { ...(init.headers || {}), ...(await authHeaders(src)) } });
  if (r.status === 401 && src.login) r = await fetch(url, { ...init, headers: { ...(init.headers || {}), ...(await authHeaders(src, true)) } });
  return r;
}
const cache = new Map();
async function comments(src, fresh) {
  // A file store may hold read-only mirrors of another source (`remote: true`, e.g. a project's `notes pull`):
  // that source has its own tab, so they are left out here.
  if (src.kind === 'file') return fileStore(ROOT, src.dir || '.dev-comments').read().comments.filter((c) => !c.remote);
  const c = cache.get(src.id);
  if (!fresh && c && Date.now() - c.at < 3000) return c.data;
  const r = await remote(src, src.endpoint);
  if (!r.ok) throw new Error(`${src.label} answered ${r.status}`);
  const data = (await r.json()).comments || [];
  cache.set(src.id, { at: Date.now(), data });
  return data;
}
async function change(src, id, body) {
  if (src.kind === 'file') return fileStore(ROOT, src.dir || '.dev-comments').update((d) => patchComment(d, id, body));
  const r = await remote(src, `${src.endpoint}/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${src.label} answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  cache.delete(src.id);
  return r.json();
}

// ---------- the page server
const send = (res, code, data) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(data)); };
// 40 MB: eight pasted screenshots as base64, and not a byte more (a request is read into memory whole)
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 40e6) { s = ''; req.destroy(); ok({}); } }); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } }); });
const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const file = (res, f) => { if (!fs.existsSync(f)) { res.statusCode = 404; return res.end(); } res.setHeader('content-type', TYPES[f.split('.').pop()] || 'application/octet-stream'); res.setHeader('cache-control', 'no-store'); res.end(fs.readFileSync(f)); };

// Only the desk's own page may talk to it. Without this any website open in the same browser could post "a message
// from the owner" to Claude through http://127.0.0.1:<port> : the Host header must be this server (no DNS
// rebinding), a change must come as JSON (a cross-site page can't send that without a preflight, which is never
// answered) and, when the browser says where it comes from, from this page.
const OWN = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
function guard(req, res) {
  if (!OWN.includes(req.headers.host || '')) { res.statusCode = 403; res.end('Forbidden'); return false; }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && !OWN.some((h) => origin === 'http://' + h)) { res.statusCode = 403; res.end('Forbidden'); return false; }
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) { res.statusCode = 415; res.end('JSON only'); return false; }
  }
  return true;
}
async function handle(req, res) {
  if (!guard(req, res)) return;
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  if (p === '/' && req.method === 'GET') {
    // the page's own scripts carry a one-time nonce; nothing else may run (a script smuggled into a comment can't)
    const nonce = crypto.randomBytes(16).toString('base64');
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store');
    res.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
    return res.end(fs.readFileSync(path.join(HERE, 'desk.html'), 'utf8').replaceAll('<script>', `<script nonce="${nonce}">`));
  }

  if (p === '/api/state' && req.method === 'GET') {
    const st = await store.get();
    const out = { me: ME, project: CFG.name || path.basename(ROOT), sources: SOURCES.map(({ id, label, audience, site, room }) => ({ id, label, audience: audience || null, site: site || '', room: room || '' })), comments: {}, errors: [], notes: st.notes, chat: st.chat, feed: st.feed.slice(-40).reverse() };
    for (const s of SOURCES) {
      try { out.comments[s.id] = await comments(s, url.searchParams.has('fresh')); } catch (e) { out.comments[s.id] = []; out.errors.push(`${s.label}: ${e.message}`); }
      for (const c of out.comments[s.id]) c.shots = { now: fs.existsSync(path.join(s.shots, `${c.id}.png`)), before: fs.existsSync(path.join(s.shots, 'before', `${c.id}.png`)) };
    }
    return send(res, 200, out);
  }

  let m = /^\/api\/comment\/([\w-]+)\/(\d+)$/.exec(p);
  if (m && req.method === 'POST') {
    const src = source(m[1]); if (!src) return send(res, 404, { error: 'No such source.' });
    const b = await body(req); const text = String(b.text || '').trim();
    const ch = b.action === 'resolve' ? { status: 'resolved' } : b.action === 'reopen' ? { status: 'open' } : b.action === 'reply' && text ? { reply: { by: ME, text } } : null;
    if (!ch) return send(res, 400, { error: 'Unknown action, or an empty reply.' });
    try { const c = await change(src, m[2], ch); return c ? send(res, 200, c) : send(res, 404, { error: 'No such comment.' }); }
    catch (e) { return send(res, 502, { error: e.message }); }
  }

  m = /^\/api\/chat\/([\w-]+)\/(\d+)$/.exec(p);
  if (m && req.method === 'POST') {
    if (!source(m[1])) return send(res, 404, { error: 'No such source.' });
    const b = await body(req); const text = String(b.text || '').trim();
    const shots = (Array.isArray(b.images) ? b.images : []).slice(0, 8);
    if (!text && !shots.length) return send(res, 400, { error: 'Write something or paste a screenshot.' });
    try { const msg = await store.chat(m[1], m[2], ME, text, shots); trust(msg); return send(res, 200, msg); } catch (e) { return send(res, 502, { error: e.message }); }
  }

  m = /^\/upload\/([\w.-]+)$/.exec(p);
  if (m && req.method === 'GET') { try { return file(res, await store.image(m[1])); } catch { res.statusCode = 404; return res.end(); } }
  m = /^\/shot\/([\w-]+)\/(\d+)(\/before)?$/.exec(p);
  if (m && req.method === 'GET') { const src = source(m[1]); if (!src) { res.statusCode = 404; return res.end(); } return file(res, path.join(src.shots, m[3] ? 'before' : '', `${m[2]}.png`)); }

  res.statusCode = 404; res.end('Not found');
}

// ---------- Telegram: asking the owner about a message from the hosted desk, and reading his answer
const tgToken = () => { try { return execFileSync('security', ['find-generic-password', '-s', 'dev-comments-telegram', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const tgChat = () => String(CFG.watch?.telegram?.chatId || '');
async function tg(method, body) {
  const t = tgToken(); if (!t || !tgChat()) throw new Error('Telegram is not set up (/comments alerts)');
  const j = await (await fetch(`${process.env.DESK_TELEGRAM_API || 'https://api.telegram.org'}/bot${t}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
  return j.result;
}
const ASKED = path.join(STATE_DIR, 'asked.json');
const asked = () => { try { return JSON.parse(fs.readFileSync(ASKED, 'utf8')); } catch { return { offset: 0, q: {} }; } };
const saveAsked = (a) => { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(ASKED, JSON.stringify(a)); };
async function ask({ k, m }) {
  const a = asked(); const h = msgHash(m);
  if (a.q[h]) return;
  const [src, id] = k.split(':');
  const sent = await tg('sendMessage', { chat_id: tgChat(), disable_web_page_preview: true,
    text: `${CFG.name || 'Desk'}: a message for Claude from the hosted desk, card #${id} (${source(src)?.label || src}):\n\n${m.text || '(no text)'}${(m.images || []).length ? `\n[+${m.images.length} image${m.images.length > 1 ? 's' : ''}]` : ''}\n\nReply "ok" to this message to let Claude work on it: now or any time in the next 7 days. If this wasn't you, don't answer.` });
  a.q[h] = { at: Date.now(), k, id: m.id, tgId: sent.message_id, text: m.text || '', images: (m.images || []).length };
  saveAsked(a);
}

// ---------- CLI
const argv = process.argv.slice(2);
const [cmd, ...a] = argv;
const flag = (name) => argv.flatMap((x, i) => (x === name && argv[i + 1] ? [argv[i + 1]] : []));
const plain = a.filter((x, i) => !x.startsWith('--') && !(a[i - 1] || '').startsWith('--'));
const fail = (msg) => { console.error(msg); process.exit(1); };
const checkSrc = (src, id) => { if (!source(src)) fail(`source is one of: ${SOURCES.map((s) => s.id).join(', ')}`); if (!Number(id)) fail('id is a comment number'); };
const unanswered = (s) => Object.entries(s.chat).flatMap(([k, msgs]) => msgs.filter((x) => x.by !== 'Claude' && x.status !== 'answered').map((x) => ({ k, m: x })));
const show = async ({ k, m }) => {
  const [src, id] = k.split(':');
  console.log(`\n[${k}] #${id} (${source(src)?.label || src}) · ${m.by} · ${m.at}`);
  console.log(m.text || '(no text)');
  for (const f of m.images || []) console.log('  image: ' + (await store.image(f)));
};

switch (cmd) {
  case 'serve': {
    const port = PORT;
    http.createServer((req, res) => handle(req, res).catch((e) => send(res, 500, { error: e.message }))).listen(port, '127.0.0.1', () => console.log(`Comment Desk for ${CFG.name || path.basename(ROOT)}: http://127.0.0.1:${port}/`));
    break;
  }
  case 'wait': {
    for (;;) {
      let got = [];
      try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(path.join(STATE_DIR, 'watcher.alive'), new Date().toISOString()); } catch {}   // "a session is on it" for the Telegram listener
      try {
        const open = unanswered(await store.get()).filter(({ m }) => m.status === 'new' || m.status === 'held');
        if (REMOTE) {   // only what this Mac trusts; everything else becomes a question on Telegram
          const outside = open.filter(({ m }) => !trusted().has(msgHash(m)));
          for (const c of outside) await ask(c);   // the owner approves on Telegram whenever he likes (tg-listener.mjs records it)
          got = open.filter(({ m }) => trusted().has(msgHash(m)));
        } else got = open;   // no hosted desk: every message was typed on this Mac
        if (got.length) await store.seen(got.map(({ m }) => m.id));
      } catch (e) { console.error(new Date().toISOString(), e.message); }   // offline for a moment: keep waiting
      if (got.length) { for (const g of got) await show(g); break; }
      await new Promise((r) => setTimeout(r, 3000));
    }
    break;
  }
  case 'pending': { const l = unanswered(await store.get()); if (!l.length) console.log('nothing waiting'); for (const g of l) await show(g); break; }
  case 'say': {
    const [src, id, ...rest] = plain; checkSrc(src, id);
    const text = rest.join(' ').trim(); const lane = flag('--lane')[0];
    if (lane && !LANES.includes(lane)) fail('lane is one of: ' + LANES.join(', '));
    const images = flag('--img').map((f) => { if (!fs.existsSync(f)) fail('no such image: ' + f); return toDataUrl(f); });
    if (!text && !images.length) fail('say needs text or --img');
    await store.chat(src, id, 'Claude', text, images);
    if (lane) await store.note(src, id, lane);
    console.log(`#${id} (${src}) ← Claude${lane ? ' · ' + lane : ''}`);
    break;
  }
  case 'note': {
    const [src, id, lane, ...text] = plain; checkSrc(src, id);
    if (!LANES.includes(lane)) fail('lane is one of: ' + LANES.join(', '));
    // A new status answers what the owner said on that card ("done", "ok good"): without this the card sat under
    // "With Claude" although it was already on staging.
    await store.note(src, id, lane, text.join(' ').trim());
    console.log(`#${id} (${src}) → ${lane}`); break;
  }
  case 'clear': { const [src, id] = plain; await store.clear(src, id); console.log(`#${id} (${src}) note cleared`); break; }
  case 'feed': { const t = plain.join(' ').trim(); if (!t) fail('feed "text"'); await store.feed([t]); console.log('feed +1'); break; }
  case 'show': console.log(JSON.stringify(await store.get(), null, 2)); break;
  default: console.log('desk.mjs serve | wait | pending | say <src> <id> "text" [--img f] [--lane l] | note <src> <id> <lane> "text" | clear <src> <id> | feed "text" | show');
}
