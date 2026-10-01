#!/usr/bin/env node
// Comment watch (dev-comments skill): checks a project's remote comment sources (a staging site), and when someone
// wrote something new it updates the Comment Desk and sends the owner a Telegram message. Meant to run on a timer
// (macOS launchd, every hour) so it works without a Claude session open.
//
//   node watch.mjs check            one check: compare with the last check, notify about what is new
//   node watch.mjs check --quiet    record the current state without notifying (the first run does this by itself)
//   node watch.mjs telegram-setup   after messaging your bot once: find the chat id and save it in .comment-desk.json
//   node watch.mjs telegram-setup <id>   save a chat id you already know (from @userinfobot)
//   node watch.mjs test             send a test message
//
// Reads .comment-desk.json (the Comment Desk's config): every source with kind "http" is watched. Optional keys:
//   "watch": { "shot": "node integrations/dev-comments/comments.mjs shot {id}",   screenshot each new comment
//              "telegram": { "chatId": "123456789" } }
// The bot token is never in a file: macOS Keychain, service "dev-comments-telegram" (security add-generic-password
// -s dev-comments-telegram -a "$USER" -w), or the env var TELEGRAM_BOT_TOKEN.
// What counts as new: a comment id not seen before, or a reply by anyone other than the owner ("me") and Claude.
// Last state: <state>/watch.json. Nothing is ever written to the watched site.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

function findRoot(dir = process.cwd()) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.comment-desk.json'))) return d;
    if (path.dirname(d) === d) return null;
  }
}
const ROOT = findRoot();
if (!ROOT) { console.error('No .comment-desk.json in this folder or above it.'); process.exit(1); }
const CFG_FILE = path.join(ROOT, '.comment-desk.json');
const CFG = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
const LOCAL = path.join(ROOT, '.comment-desk.local.json');   // git-ignored: the hosted desk's address (desk.mjs)
const REMOTE = (() => { try { const r = JSON.parse(fs.readFileSync(LOCAL, 'utf8')).remote; return r && r.url ? { ...r, url: r.url.replace(/\/$/, '') } : null; } catch { return null; } })();
const ME = CFG.me || 'you';
const STATE_DIR = path.resolve(ROOT, CFG.state || '.comment-desk');
const LAST = path.join(STATE_DIR, 'watch.json');
const DESK_STATE = path.join(STATE_DIR, 'state.json');
const NAME = CFG.name || path.basename(ROOT);
const log = (...a) => console.log(new Date().toISOString(), ...a);

function token() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  try { return execFileSync('security', ['find-generic-password', '-s', 'dev-comments-telegram', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}
async function telegram(method, body) {
  const t = token(); if (!t) throw new Error('no Telegram bot token (Keychain service "dev-comments-telegram")');
  const r = await fetch(`https://api.telegram.org/bot${t}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || r.status}`);
  return j.result;
}
const notify = (text) => {
  const chatId = CFG.watch?.telegram?.chatId;
  if (!chatId) throw new Error('no chat id yet: run `node watch.mjs telegram-setup`');
  return telegram('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
};

function basicAuth(file) {
  const t = fs.readFileSync(path.resolve(ROOT, file), 'utf8').trim();
  const m = /(\S+)\s*\/\s*(\S+)\s*$/.exec(t) || /^([^:\s]+):(\S+)$/.exec(t);
  return 'Basic ' + Buffer.from(m[1] + ':' + m[2]).toString('base64');
}
async function fetchComments(src) {
  const r = await fetch(src.endpoint, { headers: src.authFile ? { authorization: basicAuth(src.authFile) } : {} });
  if (!r.ok) throw new Error(`${src.label}: ${r.status}`);
  return (await r.json()).comments || [];
}

// the hosted desk (when there is one): its shared store gets the feed lines and the screenshots
function deskToken() {
  if (process.env.COMMENT_DESK_TOKEN) return process.env.COMMENT_DESK_TOKEN;
  return execFileSync('security', ['find-generic-password', '-s', REMOTE.tokenKeychain, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
async function deskPost(p, body) {
  const r = await fetch(REMOTE.url + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-desk-token': deskToken(), ...(REMOTE.authFile ? { authorization: basicAuth(REMOTE.authFile) } : {}) }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`hosted desk answered ${r.status} for ${p}`);
}

// the desk's side column gets a line for each thing that happened (same lock as the desk)
async function deskFeed(lines) {
  if (!lines.length) return;
  if (REMOTE) { try { await deskPost('/api/desk/feed', { lines }); } catch (e) { log('desk feed failed:', e.message); } return; }
  const lock = path.join(STATE_DIR, '.lock');
  fs.mkdirSync(STATE_DIR, { recursive: true });
  for (let i = 0; i < 200; i++) { try { fs.mkdirSync(lock); break; } catch { const t = Date.now() + 25; while (Date.now() < t) { /* wait */ } } }
  try {
    let s = { notes: {}, feed: [], chat: {}, nextMsg: 1 };
    try { s = Object.assign(s, JSON.parse(fs.readFileSync(DESK_STATE, 'utf8'))); } catch {}
    const at = new Date().toISOString();
    for (const text of lines) s.feed.push({ at, text });
    s.feed = s.feed.slice(-200);
    fs.writeFileSync(DESK_STATE + '.tmp', JSON.stringify(s, null, 2) + '\n'); fs.renameSync(DESK_STATE + '.tmp', DESK_STATE);
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

const clip = (s, n = 160) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const hm = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

async function check(quiet) {
  let last = {}; try { last = JSON.parse(fs.readFileSync(LAST, 'utf8')); } catch {}
  const first = !Object.keys(last).length;
  const now = {}; const news = []; const errors = [];
  for (const src of (CFG.sources || []).filter((s) => s.kind === 'http')) {
    let list; try { list = await fetchComments(src); } catch (e) { errors.push(e.message); now[src.id] = last[src.id] || {}; continue; }
    const seen = last[src.id] || {};
    now[src.id] = {};
    for (const c of list) {
      const others = (c.replies || []).filter((r) => r.by !== ME && r.by !== 'Claude');
      now[src.id][c.id] = { others: others.length, status: c.status };
      if (first || quiet) continue;
      const was = seen[c.id];
      // the link opens the card in the hosted desk (phone), else the comment on the site itself
      const link = REMOTE ? `${REMOTE.url}/#${src.id}-${c.id}` : src.site ? `${src.site}${(c.url || c.page || '/').split('#')[0]}#dc=${c.id}` : '';
      if (!was) news.push({ src, c, kind: 'new', text: c.text, by: c.author, at: c.createdAt, link });
      else for (const r of others.slice(was.others)) news.push({ src, c, kind: 'reply', text: r.text, by: r.by, at: r.at, link });
    }
  }
  const save = () => { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(LAST, JSON.stringify(now, null, 2) + '\n'); };
  if (errors.length) log('errors:', errors.join('; '));
  if (!news.length) { save(); log(first && !quiet ? 'first run: recorded the current comments, nothing to report' : 'nothing new'); return; }

  // tell the owner first: if Telegram is set up but can't be reached, keep the old state so the next check retries
  const body = [`${NAME}: ${news.length} new on ${[...new Set(news.map((n) => n.src.label))].join(', ')}`, '']
    .concat(news.map((n) => `#${n.c.id} ${n.kind === 'new' ? 'new' : 'reply'} · ${n.by} · ${hm(n.at)}\n${clip(n.text)}\n${n.c.page || ''}${n.link ? '\n' + n.link : ''}`).join('\n\n'))
    .concat(['', REMOTE ? 'Tap a link to answer in the desk.' : 'Open the Comment Desk on your Mac to answer.']).join('\n');
  if (CFG.watch?.telegram?.chatId) {
    try { await notify(body); log(`notified: ${news.length} new`); }
    catch (e) { log('Telegram failed, will retry next check:', e.message); process.exitCode = 1; return; }
  } else log(`${news.length} new (Telegram not set up yet)`);
  save();

  // screenshots of new comments, for the desk
  const shot = CFG.watch?.shot;
  if (shot) for (const n of news.filter((x) => x.kind === 'new')) {
    try { execSync(shot.replace('{id}', String(n.c.id)), { cwd: ROOT, stdio: 'ignore', timeout: 120000 }); } catch { log(`shot of #${n.c.id} failed`); continue; }
    const f = path.join(path.resolve(ROOT, n.src.shots || '.dev-comments/shots'), `${n.c.id}.png`);   // and to the hosted desk
    if (REMOTE && fs.existsSync(f)) { try { await deskPost('/api/desk/shot', { id: n.c.id, data: 'data:image/png;base64,' + fs.readFileSync(f).toString('base64') }); } catch (e) { log('shot upload failed:', e.message); } }
  }
  await deskFeed(news.map((n) => `${n.kind === 'new' ? 'New comment' : 'New reply'} #${n.c.id} from ${n.by} (${n.src.label}, ${hm(n.at)}): ${clip(n.text, 120)}`));
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'check': await check(rest.includes('--quiet')); break;
  case 'test': await notify(`${NAME}: test message from the comment watch. If you can read this, notifications work.`); log('sent'); break;
  case 'telegram-setup': {
    if (/^-?\d+$/.test(rest[0] || '')) {   // the chat id given directly (from @userinfobot), for a bot something else already reads
      CFG.watch = Object.assign({}, CFG.watch, { telegram: { chatId: rest[0] } });
      fs.writeFileSync(CFG_FILE, JSON.stringify(CFG, null, 2) + '\n');
      console.log('Saved chat id ' + rest[0] + ' in .comment-desk.json');
      break;
    }
    let ups;
    try { ups = await telegram('getUpdates', {}); }
    catch (e) { console.log(`Can't read the bot's messages (${e.message}): something else probably reads them. Ask @userinfobot for your id and run: telegram-setup <id>`); process.exit(1); }
    const chats = [...new Map(ups.map((u) => (u.message || u.my_chat_member || {}).chat).filter(Boolean).map((c) => [c.id, c])).values()];
    if (!chats.length) { console.log('No messages yet: open your bot in Telegram, press Start (or send it "hi"), then run this again.'); process.exit(1); }
    const chat = chats[chats.length - 1];
    CFG.watch = Object.assign({}, CFG.watch, { telegram: { chatId: String(chat.id) } });
    fs.writeFileSync(CFG_FILE, JSON.stringify(CFG, null, 2) + '\n');
    console.log(`Saved chat id for ${chat.first_name || chat.title || chat.username || chat.id} in .comment-desk.json`);
    break;
  }
  default: console.log('watch.mjs check [--quiet] | test | telegram-setup');
}
