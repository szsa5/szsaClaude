// dev-comments: pictures pasted or dropped into a note or a reply. The page sends them as data: URLs in the
// JSON; each one is checked here (an image type, its first bytes really that type, at most 8 MB, at most 6 a message),
// written to <dir>/att/ under a name made here, and only that name is kept with the comment. The same names are served
// back read-only, with headers that stop a browser from treating them as anything but a picture. Nothing a browser
// sends ever becomes a path.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_IMAGES = 6, MAX_BYTES = 8e6;
/** the only names ever stored or served */
export const IMAGE_NAME = /^[a-z0-9]{6,20}-[a-f0-9]{12}\.(png|jpg|webp|gif)$/;
const KINDS = {
  'image/png': ['png', (b) => b.length > 8 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG'],
  'image/jpeg': ['jpg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  'image/webp': ['webp', (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'],
  'image/gif': ['gif', (b) => b.length > 6 && b.toString('ascii', 0, 4) === 'GIF8'],
};
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/** check and write the pictures of one message; returns their names. Throws (the API answers 400) on anything else */
export function saveImages(folder, list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error('images must be a list');
  if (list.length > MAX_IMAGES) throw new Error(`at most ${MAX_IMAGES} pictures in one message`);
  const ready = list.map((v) => {
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(typeof v === 'string' ? v : '');
    if (!m) throw new Error('a picture must be a PNG, JPEG, WebP or GIF');
    const buf = Buffer.from(m[2], 'base64'), [ext, isIt] = KINDS[m[1]];
    if (buf.length > MAX_BYTES) throw new Error('a picture may be at most 8 MB');
    if (!isIt(buf)) throw new Error('that file is not the picture it says it is');
    return { buf, ext };
  });
  const dir = path.join(folder, 'att');
  if (ready.length) fs.mkdirSync(dir, { recursive: true });
  return ready.map(({ buf, ext }) => {
    const name = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(dir, name), buf);
    return name;
  });
}

/** the stored names of a message, kept only if they look like ours (a store can be edited by hand, or pulled from elsewhere) */
export const imageNames = (list) => (Array.isArray(list) ? list.filter((n) => typeof n === 'string' && IMAGE_NAME.test(n)).slice(0, MAX_IMAGES) : []);

/** answer GET <route>/att/<name> */
export function serveImage(folder, name, res) {
  const file = IMAGE_NAME.test(name) ? path.join(folder, 'att', name) : null;
  if (!file || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
  res.statusCode = 200;
  res.setHeader('content-type', MIME[name.split('.').pop()]);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  res.setHeader('cache-control', 'private, max-age=86400, immutable');
  fs.createReadStream(file).pipe(res);
}

/** where a stored picture is on disk, for the CLI (null for a name that is not ours) */
export const imagePath = (folder, name) => (IMAGE_NAME.test(name) ? path.join(folder, 'att', name) : null);
