#!/usr/bin/env node
// dev-comments API without Vite (Next.js, Rails, plain static…): a tiny local server next to your dev server.
//   node integrations/dev-comments/serve.mjs [--port 4777]      run from the project root
// then mount the overlay with mount({ route: 'http://localhost:4777/__dev-comments' }) in a dev-only script.
import http from 'node:http';
import { store } from './store.mjs';
import { handler, ROUTE, originOk } from './index.mjs';

const i = process.argv.indexOf('--port');
const port = Number(i > 0 ? process.argv[i + 1] : 4777);
const api = handler(store(process.cwd()));
http.createServer((req, res) => {
  // the page runs on another port, so CORS is needed; only a local page's origin is ever echoed back (index.mjs)
  if (req.headers.origin && originOk(req)) res.setHeader('access-control-allow-origin', req.headers.origin);
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (!req.url.startsWith(ROUTE)) { res.statusCode = 404; return res.end(); }
  req.url = req.url.slice(ROUTE.length) || '/';
  api(req, res);
}).listen(port, '127.0.0.1', () => console.log(`dev-comments API on http://localhost:${port}${ROUTE}  (file: ${store(process.cwd()).file})`));
