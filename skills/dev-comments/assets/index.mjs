// dev-comments: click anywhere on the running dev site, leave a note; notes land in .dev-comments/comments.json
// where the coding agent reads them (cli.mjs). Dev server only: nothing is added to a production build.
//
//   Astro:  integrations: [devComments({ bottomMobile: 72 })]
//   Vite:   plugins: [devCommentsVite(), ...]  + import { mount } from '.../client.js'; mount() in a dev-only entry
//   Other:  node integrations/dev-comments/serve.mjs  + mount({ route: 'http://localhost:4777/__dev-comments' })
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store, createComment, patchComment, deleteComment, DIR } from './store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROUTE = '/__dev-comments';

// Who may use this API. It writes notes that the coding agent then acts on, so "any page open in the browser" is
// not good enough (found in a security review):
//  - the Host must be localhost or an IP address, never a DNS name: a name is how a page does DNS rebinding;
//  - a browser that says where it comes from (Origin) must come from a local page, or from this very server;
//  - a write must be application/json, which a cross-site page cannot send without a preflight, and the preflight
//    gets no CORS answer unless the origin passed the rule above.
const LOCAL_NAME = /^(localhost|[\w-]+\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i;
const IP = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;
const hostname = (host) => String(host || '').replace(/:\d+$/, '');
export const hostOk = (req) => { const h = hostname(req.headers.host); return LOCAL_NAME.test(h) || IP.test(h); };
export function originOk(req) {
  const o = req.headers.origin; if (!o) return true;   // not a browser page (curl, the CLI)
  try { const u = new URL(o); return LOCAL_NAME.test(u.hostname) || u.host === req.headers.host; } catch { return false; }
}
const JSON_BODY = /^application\/json\b/i;

const send = (res, code, data) => { res.statusCode = code; if (code === 204) return res.end(); res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(data)); };
const body = (req) => new Promise((resolve) => { let s = ''; req.on('data', (d) => { s += d; if (s.length > 2e6) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } }); });

/** The JSON API as a connect-style handler (Vite middleware, or the standalone serve.mjs). */
export function handler(db, opts = {}) {
  return async (req, res) => {
    const id = (req.url || '/').split('?')[0].replace(/^\/+/, '');
    try {
      if (!hostOk(req) || !originOk(req)) return send(res, 403, { error: 'only pages on this machine may use the comments API' });
      if ((req.method === 'POST' || req.method === 'PATCH') && !JSON_BODY.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'send JSON' });
      if (req.method === 'OPTIONS') return send(res, 204, {});
      if (req.method === 'GET') return send(res, 200, db.read());
      if (req.method === 'POST' && !id) { const b = await body(req); if (!String(b.text || '').trim()) return send(res, 400, { error: 'text is required' }); return send(res, 201, db.update((d) => createComment(d, b, opts.author || 'you'))); }
      if (req.method === 'PATCH' && id) { const b = await body(req); const c = db.update((d) => patchComment(d, id, b)); return c ? send(res, 200, c) : send(res, 404, { error: 'no such comment' }); }
      if (req.method === 'DELETE' && id) { const ok = db.update((d) => deleteComment(d, id)); return ok ? send(res, 200, { ok }) : send(res, 404, { error: 'no such comment' }); }
      send(res, 405, { error: 'method not allowed' });
    } catch (e) { send(res, 500, { error: String((e && e.message) || e) }); }
  };
}

/** Vite plugin: the JSON API on the dev server. */
export function devCommentsVite(opts = {}) {
  const dir = opts.dir || DIR;
  return {
    name: 'dev-comments',
    apply: 'serve',
    config: () => ({ server: { watch: { ignored: [`**/${dir}/**`] } } }),   // writing a comment must not reload the page
    configureServer(server) { server.middlewares.use(ROUTE, handler(store(server.config.root, dir), opts)); },
  };
}

/** Astro integration: the API plus the overlay on every page, only under `astro dev`. */
export default function devComments(opts = {}) {
  const client = { route: ROUTE, author: opts.author || 'you', accent: opts.accent, bottom: opts.bottom, bottomMobile: opts.bottomMobile, side: opts.side, storagePrefixes: opts.storagePrefixes };
  return {
    name: 'dev-comments',
    hooks: {
      'astro:config:setup': ({ command, injectScript, updateConfig }) => {
        if (command !== 'dev') return;
        updateConfig({ vite: { plugins: [devCommentsVite(opts)] } });
        injectScript('page', `import { mount } from ${JSON.stringify(path.join(HERE, 'client.js'))}; mount(${JSON.stringify(client)});`);
      },
    },
  };
}
