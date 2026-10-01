#!/usr/bin/env node
// dev-comments CLI, for the coding agent (and anyone at a terminal). Run from the project root.
//
//   node integrations/dev-comments/cli.mjs list [--all]          open comments (or all), with a source-file guess
//   node integrations/dev-comments/cli.mjs show <id>             everything captured for one comment
//   node integrations/dev-comments/cli.mjs shot <id> [--base URL] screenshot at the commenter's width, theme and settings
//   node integrations/dev-comments/cli.mjs reply <id> "text"     answer in the thread (shows up live on the page)
//   node integrations/dev-comments/cli.mjs resolve <id> ["text"] mark done, optionally with a closing reply
//   node integrations/dev-comments/cli.mjs reopen <id> ["text"]
//   node integrations/dev-comments/cli.mjs wait [--since <id>]   block until a comment newer than <id> exists, print it
//
// Options: --by <name> (reply author, default Claude) · --base <dev server URL> (default $DEV_COMMENTS_BASE or
// http://localhost:4321) · --src <dir> (where to look for source, default src) · $DEV_COMMENTS_AUTH=user:pass for
// a site behind HTTP basic auth
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { store, patchComment } from './store.mjs';

const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf('--' + name); if (i < 0) return def; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const bool = (name) => { const i = argv.indexOf('--' + name); if (i < 0) return false; argv.splice(i, 1); return true; };
const all = bool('all');
const by = flag('by', 'Claude');
const base = (flag('base', process.env.DEV_COMMENTS_BASE || 'http://localhost:4321')).replace(/\/$/, '');
const srcDir = flag('src', 'src');
const since = Number(flag('since', '0'));
const [cmd, idArg, ...rest] = argv;
const root = process.cwd();
const db = store(root);

const get = (id) => { const c = db.read().comments.find((x) => x.id === Number(id)); if (!c) { console.error(`No comment #${id}.`); process.exit(1); } return c; };
const theme = (c) => (c.html && c.html.data && c.html.data.theme) || (c.html && c.html.darkOS ? 'os-dark' : 'light');
// A note's fields were written by a browser: never let one pick where the screenshot browser goes, and never print
// control characters (an escape sequence can rewrite what the terminal shows).
const sitePath = (v) => (typeof v === 'string' && v[0] === '/' && v[1] !== '/' && ![...v].some((ch) => ch === '\\' || ch.charCodeAt(0) < 32) ? v : null);
const clean = (s) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// ---- where in the source is this element? grep the element's own classes, then its ancestors'
const EXT = /\.(astro|html|jsx|tsx|vue|svelte|mdx|md|js|ts)$/;
let FILES = null;
function files() {
  if (FILES) return FILES; FILES = [];
  const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { if (e.name.startsWith('.') || e.name === 'node_modules') continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (EXT.test(e.name)) FILES.push([p, fs.readFileSync(p, 'utf8').split('\n')]); } };
  walk(path.resolve(root, srcDir)); return FILES;
}
function locate(c) {
  const tokens = [];
  const add = (label) => (label.match(/\.[A-Za-z_][\w-]*/g) || []).forEach((t) => tokens.push(t.slice(1)));
  if (c.element) { if (c.element.id) tokens.push(c.element.id); (c.element.classes || []).forEach((t) => tokens.push(t)); }
  (c.trail || []).forEach(add);
  const hits = [];
  for (const t of [...new Set(tokens)]) {
    const re = new RegExp(`(^|[^\\w-])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`);
    for (const [file, lines] of files()) lines.forEach((l, i) => { if (re.test(l) && /class|id=/.test(l)) hits.push(`${path.relative(root, file)}:${i + 1}  (${t})`); });
    if (hits.length) break;   // the innermost class that appears in markup wins
  }
  return hits.slice(0, 3);
}

function print(c, detail = false) {
  const log = (line) => console.log(clean(line));
  const reps = c.replies.length ? ` · ${c.replies.length} repl${c.replies.length === 1 ? 'y' : 'ies'}` : '';
  log(`#${c.id}  ${c.status.toUpperCase()}  ${c.url}  ${c.viewport ? c.viewport.w + '×' + c.viewport.h : ''} ${theme(c)}${reps}`);
  log(`    on  ${c.element ? c.element.label : '?'}${c.element && c.element.text ? `  "${short(c.element.text, 60)}"` : ''}`);
  log(`    ${detail ? c.text.split('\n').join('\n    ') : short(c.text, 140)}`);
  const src = locate(c); if (src.length) log(`    src ${src[0]}${detail && src.length > 1 ? '\n        ' + src.slice(1).join('\n        ') : ''}`);
  if (detail) {
    if (c.selector) log(`    selector  ${c.selector}   at ${Math.round((c.fx || 0) * 100)}%, ${Math.round((c.fy || 0) * 100)}% of the element`);
    if (c.trail && c.trail.length) log(`    inside    ${c.trail.join(' < ')}`);
    if (c.html && c.html.data && Object.keys(c.html.data).length) log(`    <html>    ${Object.entries(c.html.data).map(([k, v]) => `data-${k}=${v}`).join(' ')}`);
    if (c.storage && Object.keys(c.storage).length) log(`    storage   ${Object.entries(c.storage).map(([k, v]) => `${k}=${short(v, 40)}`).join(' · ')}`);
    c.replies.forEach((r) => log(`    ↳ ${r.by}: ${r.text.split('\n').join('\n      ')}`));
  }
  log('');
}

async function shot(c) {
  const require = createRequire(path.join(root, 'package.json'));
  let pw; try { pw = require('playwright'); } catch { console.error('Playwright is not installed in this project (npm i -D playwright).'); process.exit(1); }
  const browser = await pw.chromium.launch({ channel: 'chrome' }).catch(() => pw.chromium.launch());
  const vp = c.viewport || { w: 1440, h: 900, dpr: 1 };
  const auth = process.env.DEV_COMMENTS_AUTH;   // "user:pass" when the site sits behind HTTP basic auth (a staging server)
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: Math.min(2, vp.dpr || 1), colorScheme: c.html && c.html.darkOS ? 'dark' : 'light', isMobile: vp.w < 600, hasTouch: vp.w < 600, httpCredentials: auth ? { username: auth.split(':')[0], password: auth.slice(auth.indexOf(':') + 1) } : undefined });
  // replay the commenter's saved settings (theme, design panel…) before any page script runs
  await ctx.addInitScript((s) => { try { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } catch {} }, c.storage || {});
  const page = await ctx.newPage();
  const target = new URL(sitePath(c.url) || sitePath(c.page) || '/', base + '/');
  if (target.origin !== new URL(base).origin) { console.error(`#${c.id}: its url does not point at ${base}; not opening it`); process.exit(1); }
  await page.goto(target.href, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1200);
  // some hosts answer with a bot check that navigates once more after load; if that lands mid-evaluate, wait and try again
  const mark = async (c) => page.evaluate(markFn, c);
  let found; try { found = await mark(c); } catch (e) { if (!/context was destroyed|navigation/i.test(String(e.message))) throw e; await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(1500); found = await mark(c); }
  async function markFn(c) {
    document.querySelector('dev-comments')?.remove();
    let el = null; try { el = document.querySelector(c.selector); } catch {}
    if (el) el.scrollIntoView({ block: 'center' }); else window.scrollTo(0, c.docY - innerHeight / 2);
    await new Promise((r) => setTimeout(r, 900));
    const r = el ? el.getBoundingClientRect() : null;
    const x = r ? r.left + r.width * c.fx : c.docX - scrollX, y = r ? r.top + r.height * c.fy : c.docY - scrollY;
    const mark = document.createElement('div');
    mark.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    if (r) mark.innerHTML += `<div style="position:fixed;left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:2px dashed #ff4f1a;border-radius:3px"></div>`;
    mark.innerHTML += `<div style="position:fixed;left:${x - 3}px;top:${y - 25}px;min-width:28px;height:28px;padding:0 7px;border-radius:14px 14px 14px 3px;background:#ff4f1a;border:2px solid #fff;color:#fff;font:700 12px/24px system-ui;text-align:center;box-shadow:0 4px 14px rgba(0,0,0,.35)">${Number(c.id)}</div>`;
    document.documentElement.appendChild(mark);
    return !!el;
  }
  const out = path.join(db.folder, 'shots', `${c.id}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  await browser.close();
  console.log(out + (found ? '' : '   (element not found: marked by page position)'));
}

switch (cmd) {
  case 'list': {
    const cs = db.read().comments.filter((c) => all || c.status !== 'resolved');
    if (!cs.length) console.log(all ? 'No comments.' : 'No open comments.');
    cs.forEach((c) => print(c));
    break;
  }
  case 'show': print(get(idArg), true); break;
  case 'shot': await shot(get(idArg)); break;
  case 'reply': case 'resolve': case 'reopen': {
    get(idArg);
    const text = rest.join(' ').trim();
    if (cmd === 'reply' && !text) { console.error('reply needs text'); process.exit(1); }
    const c = db.update((d) => patchComment(d, idArg, { reply: text ? { by, text } : undefined, status: cmd === 'resolve' ? 'resolved' : cmd === 'reopen' ? 'open' : undefined }));
    console.log(`#${c.id} ${c.status}${text ? ' · replied' : ''}`);
    break;
  }
  case 'wait': {
    const newest = () => db.read().comments.filter((c) => c.id > since && c.status !== 'resolved');
    let got = newest();
    while (!got.length) { await new Promise((r) => setTimeout(r, 2000)); got = newest(); }
    got.forEach((c) => print(c, true));
    break;
  }
  default:
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
