#!/usr/bin/env node
// Telegram listener (dev-comments skill): the ONE reader of the notification bot's incoming messages, for every
// project. Telegram gives a bot a single queue (and drops what nobody reads within 24 hours), so no project reads it
// itself: this listener runs all the time (macOS launchd, KeepAlive) and records the owner's approvals in the right
// project, whether or not a Claude session is open. Those approvals are what `desk.mjs wait` acts on, possibly hours
// later.
//
// What the owner can send (only from his own chat, watch.telegram.chatId). ONLY A REPLY approves anything; a plain
// message never does:
//   - a reply "ok" (yes / go / 👍) to a question the bot asked → that one message is approved
//   - "pending" → the bot lists every open question of every project, numbered; a reply "ok" to that list approves
//     all of them, "ok 1 3" only those numbers
// A question stays open 7 days. An approval covers the exact text that was asked about (its hash), nothing else.
//
// Registry: ~/.config/dev-comments/telegram.json  { "chatId": "…", "projects": { "<key>": { "name": "…", "state": "<abs path of .comment-desk>" } } }
// Per project it reads <state>/asked.json (the questions `wait` sent, with their Telegram message ids) and writes
// <state>/trusted.json (what Claude may act on). A watcher heartbeat (<state>/watcher.alive) says whether a session
// is working on that project right now.
//   node tg-listener.mjs            run (launchd)
//   node tg-listener.mjs register <key> <project root>   add a project (reads .comment-desk.json there)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = path.join(os.homedir(), '.config/dev-comments');
const REG = path.join(DIR, 'telegram.json');
const OFFSET = path.join(DIR, 'telegram-offset');
const API = process.env.DESK_TELEGRAM_API || 'https://api.telegram.org';
const DAYS7 = 7 * 86400000;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(f + '.tmp', f); };

function token() { if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN; return execFileSync('security', ['find-generic-password', '-s', 'dev-comments-telegram', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
async function tg(method, body) {
  const r = await fetch(`${API}/bot${token()}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`); return j.result;
}

// ---------- the projects' open questions
function projects() { return Object.entries(readJson(REG, { projects: {} }).projects || {}); }
function openQuestions() {
  const out = [];
  for (const [key, p] of projects()) {
    const a = readJson(path.join(p.state, 'asked.json'), { q: {} });
    for (const [h, q] of Object.entries(a.q || {})) if (Date.now() - q.at < DAYS7) out.push({ key, p, h, q });
  }
  return out.sort((x, y) => x.q.at - y.q.at);
}
function approve(items) {
  const done = [];
  for (const it of items) {
    const tf = path.join(it.p.state, 'trusted.json');
    const t = new Set(readJson(tf, [])); t.add(it.h); writeJson(tf, [...t].slice(-2000));
    const af = path.join(it.p.state, 'asked.json'); const a = readJson(af, { q: {} }); delete a.q[it.h]; writeJson(af, a);
    done.push(it);
  }
  return done;
}
const alive = (p) => { try { return Date.now() - fs.statSync(path.join(p.state, 'watcher.alive')).mtimeMs < 60000; } catch { return false; } };
function confirmText(done) {
  const byProject = new Map();
  for (const d of done) byProject.set(d.p.name, [...(byProject.get(d.p.name) || []), d]);
  return [...byProject].map(([name, ds]) => {
    const p = ds[0].p;
    return `${name}: approved ${ds.map((d) => '#' + (d.q.k || '').split(':')[1]).join(', ')}. ${alive(p) ? 'Claude is on it.' : 'No Claude session is working on this project right now: it will be picked up as soon as one runs /comments.'}`;
  }).join('\n');
}

// ---------- the owner's messages
const YES = /^\s*(ok|okay|yes|yep|go|go ahead|do it|approve|👍|✅)\b/i;
async function handle(msg, chatId) {
  if (String(msg.chat?.id) !== chatId || String(msg.from?.id) !== chatId) return;   // only the owner's own chat
  const text = (msg.text || '').trim();
  const open = openQuestions();
  if (/^\/?pending$/i.test(text)) {
    if (!open.length) return tg('sendMessage', { chat_id: chatId, text: 'Nothing waiting for your OK.' });
    const list = open.map((o, i) => `${i + 1}. ${o.p.name} #${(o.q.k || '').split(':')[1]}: ${(o.q.text || '').slice(0, 400)}${o.q.images ? ` [+${o.q.images} image${o.q.images > 1 ? 's' : ''}]` : ''}`).join('\n\n');
    const sent = await tg('sendMessage', { chat_id: chatId, text: `Waiting for your OK:\n\n${list}\n\nReply to THIS message: "ok" approves all ${open.length}, "ok 1 3" only those numbers. Or reply "ok" to a single question.`, disable_web_page_preview: true });
    const reg = readJson(REG, {}); reg.digests = { ...(reg.digests || {}), [sent.message_id]: { hs: open.map((o) => o.h), at: Date.now() } };
    for (const [id, d] of Object.entries(reg.digests)) if (Date.now() - d.at > DAYS7) delete reg.digests[id];
    return writeJson(REG, reg);
  }
  let items = [];
  if (YES.test(text) && msg.reply_to_message) {   // only a reply approves, and only what it replies to
    const rid = msg.reply_to_message.message_id;
    const digest = (readJson(REG, {}).digests || {})[rid];
    if (digest) {
      const nums = (text.match(/\d+/g) || []).map(Number).filter((n) => n >= 1 && n <= digest.hs.length);
      const hs = nums.length ? nums.map((n) => digest.hs[n - 1]) : digest.hs;
      items = open.filter((o) => hs.includes(o.h));
    } else items = open.filter((o) => o.q.tgId === rid);
  } else if (YES.test(text) || /\b\d{6}\b/.test(text)) {
    return tg('sendMessage', { chat_id: chatId, text: 'Reply "ok" to the question itself, or send "pending" and reply "ok" to the list, so it is clear what you approve.' });
  } else return;
  if (!items.length) return tg('sendMessage', { chat_id: chatId, text: 'Nothing open matches that (already approved, answered, or older than 7 days).' });
  await tg('sendMessage', { chat_id: chatId, text: confirmText(approve(items)) });
}

// ---------- run / register
const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'register') {
  const [key, root] = args; if (!key || !root) { console.error('register <key> <project root>'); process.exit(1); }
  const cfg = readJson(path.join(root, '.comment-desk.json'), null); if (!cfg) { console.error('no .comment-desk.json in ' + root); process.exit(1); }
  const reg = readJson(REG, { projects: {} });
  reg.chatId = reg.chatId || String(cfg.watch?.telegram?.chatId || '');
  reg.projects = { ...(reg.projects || {}), [key]: { name: cfg.name || key, state: path.resolve(root, cfg.state || '.comment-desk') } };
  writeJson(REG, reg); console.log(`registered ${key}: ${reg.projects[key].name} → ${reg.projects[key].state}`);
} else {
  log('listening');
  for (;;) {
    try {
      const chatId = String(readJson(REG, {}).chatId || '');
      const offset = Number(readJson(OFFSET, 0)) || 0;
      const ups = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
      for (const u of ups) {
        writeJson(OFFSET, u.update_id + 1);
        if (u.message && chatId) await handle(u.message, chatId).catch((e) => log('handle:', e.message));
      }
    } catch (e) { log(e.message); await new Promise((r) => setTimeout(r, 10000)); }
  }
}
