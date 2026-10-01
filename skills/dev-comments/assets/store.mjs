// dev-comments: the one JSON file both the dev server and the CLI read and write.
// Shape: { next: <number>, comments: Comment[] }. Writes go through a temp file + rename, so a reader never
// sees half a file.
import fs from 'node:fs';
import path from 'node:path';

export const DIR = '.dev-comments';

export function store(root, dir = DIR) {
  const folder = path.resolve(root, dir);
  const file = path.join(folder, 'comments.json');
  const read = () => {
    try { const db = JSON.parse(fs.readFileSync(file, 'utf8')); return { next: db.next || 1, comments: db.comments || [] }; }
    catch { return { next: 1, comments: [] }; }
  };
  const write = (db) => {
    fs.mkdirSync(folder, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n');
    fs.renameSync(tmp, file);
  };
  /** read, change, write in one step; `fn` mutates db and may return a value */
  const update = (fn) => { const db = read(); const out = fn(db); write(db); return out; };
  return { folder, file, read, write, update };
}

// what a browser may set when it creates a comment; everything else is decided here
const CREATE_FIELDS = ['page', 'url', 'text', 'selector', 'fx', 'fy', 'docX', 'docY', 'viewport', 'html', 'element', 'trail', 'storage', 'userAgent'];

// the page and url are paths on the dev site; the overlay and the CLI navigate to them, so nothing else is kept
const sitePath = (v) => (typeof v === 'string' && v[0] === '/' && v[1] !== '/' && ![...v].some((ch) => ch === '\\' || ch.charCodeAt(0) < 32) ? v.slice(0, 2000) : undefined);
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : undefined);
const FIELD_TYPES = { page: sitePath, url: sitePath, fx: num, fy: num, docX: num, docY: num, selector: (v) => (typeof v === 'string' ? v.slice(0, 2000) : undefined), viewport: (v) => (v && typeof v === 'object' ? { w: num(v.w), h: num(v.h), dpr: num(v.dpr), scrollY: num(v.scrollY) } : undefined) };

export function createComment(db, body, author = 'you') {
  const c = { id: db.next++, status: 'open', author, createdAt: new Date().toISOString() };
  for (const k of CREATE_FIELDS) { const v = FIELD_TYPES[k] ? FIELD_TYPES[k](body[k]) : body[k]; if (v !== undefined) c[k] = v; }
  c.text = String(c.text || '').slice(0, 4000);
  c.replies = [];
  db.comments.push(c);
  return c;
}

/** status: 'open' | 'resolved'; reply: { by, text } appended; text: edit the note */
export function patchComment(db, id, body) {
  const c = db.comments.find((x) => x.id === Number(id));
  if (!c) return null;
  if (body.text != null) c.text = String(body.text).slice(0, 4000);
  if (body.reply && String(body.reply.text || '').trim()) c.replies.push({ by: String(body.reply.by || 'you'), text: String(body.reply.text).slice(0, 4000), at: new Date().toISOString() });
  if (body.status === 'open' || body.status === 'resolved') { c.status = body.status; c[body.status === 'resolved' ? 'resolvedAt' : 'reopenedAt'] = new Date().toISOString(); }
  c.updatedAt = new Date().toISOString();
  return c;
}

export function deleteComment(db, id) {
  const i = db.comments.findIndex((x) => x.id === Number(id));
  if (i < 0) return false;
  db.comments.splice(i, 1);
  return true;
}
