// dev-comments overlay: pick an element, leave a note, see pins and replies. Everything lives in one shadow
// root, so the site's CSS cannot reach it and it cannot reach the site. Framework-free; mount(opts) once.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); };   // the exact time, local
const LS = 'dev-comments.';
// Everything a comment carries was written by a browser (or pulled from a shared site), so it is DATA of unknown
// shape: every comment is normalised on arrival (types checked, paths checked) and every value that goes into
// innerHTML is escaped, numbers included. A "number" that turns out to be markup, or a url of "javascript:…",
// would otherwise run in the page of whoever opens the list (found in a security review).
const isNum = (v) => typeof v === 'number' && isFinite(v);
const txt = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
/** a path on this site ("/about?x=1"), or null: never javascript:, //other.host or /\other.host */
const sitePath = (v) => (typeof v === 'string' && v[0] === '/' && v[1] !== '/' && ![...v].some((ch) => ch === '\\' || ch.charCodeAt(0) < 32) ? v : null);
function clean(c) {
  if (!c || typeof c !== 'object') return null;
  const id = Number(c.id); if (!Number.isInteger(id)) return null;
  const page = sitePath(c.page) || '/';
  const vp = c.viewport && typeof c.viewport === 'object' ? { w: isNum(c.viewport.w) ? c.viewport.w : 0, h: isNum(c.viewport.h) ? c.viewport.h : 0, dpr: isNum(c.viewport.dpr) ? c.viewport.dpr : 1, scrollY: isNum(c.viewport.scrollY) ? c.viewport.scrollY : 0 } : null;
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  const html = obj(c.html), data = html && obj(html.data), el = obj(c.element);
  return Object.assign({}, c, {
    id, page, url: sitePath(c.url) || page, status: c.status === 'resolved' ? 'resolved' : 'open',
    text: txt(c.text), author: txt(c.author), createdAt: txt(c.createdAt), selector: txt(c.selector),
    fx: isNum(c.fx) ? c.fx : 0, fy: isNum(c.fy) ? c.fy : 0, docX: isNum(c.docX) ? c.docX : 0, docY: isNum(c.docY) ? c.docY : 0,
    viewport: vp, element: el ? Object.assign({}, el, { label: txt(el.label) }) : null,
    html: html ? { data: data ? Object.assign({}, data, { theme: data.theme == null ? undefined : txt(data.theme) }) : undefined, darkOS: html.darkOS === true } : null,
    replies: Array.isArray(c.replies) ? c.replies.filter(obj).map((r) => ({ by: txt(r.by), text: txt(r.text), at: txt(r.at) })) : [],
  });
}

export function mount(opts = {}) {
  if (window.__devComments) return window.__devComments;
  const o = Object.assign({ route: '/__dev-comments', author: 'you', accent: '#ff4f1a', bottom: 20, bottomMobile: 20, side: 'left', storagePrefixes: null }, JSON.parse(JSON.stringify(opts), (k, v) => (v === null ? undefined : v)));
  const html = document.documentElement;

  // ---------- host + styles
  const host = document.createElement('dev-comments');
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { --acc: ${o.accent}; --b: ${o.bottom}px; --bm: ${o.bottomMobile}px; }
    * { box-sizing: border-box; }
    .ui, .ui button, .ui textarea { font: 500 13px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: 0; text-transform: none; }
    button { cursor: pointer; }
    .bar { position: fixed; ${o.side}: 20px; bottom: var(--b); display: flex; gap: 6px; pointer-events: auto; }
    @media (max-width: 760px) { .bar { bottom: var(--bm); } }
    .fab { height: 44px; padding: 0 16px 0 12px; display: flex; align-items: center; gap: 8px; border: 0; border-radius: 22px; background: #161616; color: #fff; font-weight: 650; box-shadow: 0 8px 24px rgba(0,0,0,.28), 0 0 0 1px rgba(255,255,255,.22); }
    .fab svg { width: 18px; height: 18px; }
    .fab[aria-pressed="true"] { background: var(--acc); }
    .count { height: 44px; min-width: 44px; padding: 0 12px; border: 0; border-radius: 22px; background: #161616; color: #fff; font-weight: 700; box-shadow: 0 8px 24px rgba(0,0,0,.28), 0 0 0 1px rgba(255,255,255,.22); display: flex; align-items: center; justify-content: center; gap: 6px; }
    .count i { width: 8px; height: 8px; border-radius: 50%; background: var(--acc); }
    .count[aria-expanded="true"] { background: #fff; color: #161616; }
    .banner { align-self: center; background: #161616; color: #fff; padding: 8px 14px; border-radius: 20px; box-shadow: 0 8px 24px rgba(0,0,0,.3), 0 0 0 1px rgba(255,255,255,.22); white-space: nowrap; pointer-events: none; }
    @media (max-width: 520px) { .banner { display: none !important; } }
    .banner b { color: var(--acc); }
    .outline { position: fixed; pointer-events: none; border: 2px solid var(--acc); background: color-mix(in srgb, var(--acc) 9%, transparent); border-radius: 2px; }
    .outline span { position: absolute; left: -2px; bottom: 100%; margin-bottom: 2px; background: var(--acc); color: #fff; font: 600 11px/1 ui-monospace, Menlo, monospace; padding: 4px 6px; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }
    .outline.below span { bottom: auto; top: 100%; margin: 2px 0 0; }
    .pin { position: fixed; pointer-events: auto; transform: translate(-3px, calc(-100% + 3px)); min-width: 28px; height: 28px; padding: 0 7px; border-radius: 14px 14px 14px 3px; border: 2px solid #fff; background: var(--acc); color: #fff; font: 700 12px/24px ui-sans-serif, system-ui, sans-serif; box-shadow: 0 4px 14px rgba(0,0,0,.35); transition: transform .15s; }
    .pin:hover, .pin.on { transform: translate(-3px, calc(-100% + 3px)) scale(1.15); }
    .pin.resolved { background: #7b7b7b; }
    .pin.lost { border-style: dashed; }
    .card { position: fixed; pointer-events: auto; width: min(320px, calc(100vw - 24px)); background: #fff; color: #161616; border-radius: 12px; box-shadow: 0 18px 50px rgba(0,0,0,.35), 0 0 0 1px rgba(0,0,0,.06); overflow: hidden; }
    .card header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #eee; }
    .card header b { font-weight: 700; }
    .card header .el { color: #777; font: 500 11px/1.2 ui-monospace, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .x { border: 0; background: none; font-size: 18px; line-height: 1; color: #777; padding: 2px 4px; }
    .body { padding: 10px 12px; max-height: 46vh; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
    .msg .who { font-size: 11px; color: #777; margin-bottom: 2px; }
    .msg .who b { color: #161616; font-weight: 700; }
    .msg.agent .who b { color: var(--acc); }
    .msg p { margin: 0; white-space: pre-wrap; word-wrap: break-word; }
    textarea { width: 100%; min-height: 72px; resize: vertical; border: 1px solid #ddd; border-radius: 8px; padding: 8px 10px; color: #161616; background: #fafafa; outline: none; }
    textarea:focus { border-color: var(--acc); background: #fff; }
    .actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; padding: 0 12px 12px; }
    .btn { height: 30px; padding: 0 12px; border-radius: 15px; border: 1px solid #ddd; background: #fff; color: #161616; font-weight: 600; }
    .btn.primary { background: #161616; border-color: #161616; color: #fff; }
    .btn.accent { background: var(--acc); border-color: var(--acc); color: #fff; }
    .btn.danger { color: #c0270b; }
    .btn:disabled { opacity: .45; cursor: default; }
    .meta { font-size: 11px; color: #888; }
    .tag { display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; padding: 2px 6px; border-radius: 8px; background: color-mix(in srgb, var(--acc) 15%, #fff); color: var(--acc); }
    .tag.resolved { background: #eee; color: #777; }
    .list { position: fixed; ${o.side}: 20px; bottom: calc(var(--b) + 54px); width: min(360px, calc(100vw - 40px)); max-height: min(60vh, 560px); display: flex; flex-direction: column; pointer-events: auto; background: #fff; color: #161616; border-radius: 12px; box-shadow: 0 18px 50px rgba(0,0,0,.35); overflow: hidden; }
    @media (max-width: 760px) { .list { bottom: calc(var(--bm) + 54px); } }
    .list header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid #eee; gap: 8px; }
    .list header label { font-size: 12px; color: #555; display: flex; gap: 6px; align-items: center; }
    .rows { overflow: auto; }
    .rows h4 { margin: 0; padding: 8px 12px 4px; font: 700 10px/1 ui-monospace, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; color: #999; }
    .row { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; width: 100%; text-align: left; border: 0; background: none; padding: 8px 12px; color: inherit; border-top: 1px solid #f2f2f2; }
    .row:hover { background: #f7f7f7; }
    .row .n { grid-row: span 2; width: 24px; height: 24px; border-radius: 12px 12px 12px 3px; background: var(--acc); color: #fff; font-weight: 700; font-size: 11px; display: grid; place-items: center; }
    .row.resolved .n { background: #9a9a9a; }
    .row .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row .m { font-size: 11px; color: #888; }
    .empty { padding: 18px 12px; color: #888; }
    .row-wrap { position: relative; }
    .here { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); height: 26px; padding: 0 10px; border-radius: 13px; border: 1px solid #ddd; background: #fff; color: #161616; font-weight: 600; font-size: 12px; white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity .12s; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
    .here:hover { border-color: #161616; }
    .row-wrap:hover .here, .row-wrap:focus-within .here { opacity: 1; pointer-events: auto; }
    .row-wrap:hover .row, .row-wrap:focus-within .row { padding-right: 104px; }
    @media (hover: none) { .here { opacity: 1; pointer-events: auto; } .row { padding-right: 104px; } }
    .card.float { box-shadow: 0 22px 60px rgba(0,0,0,.42), 0 0 0 1px rgba(0,0,0,.08); }
    .card.float header { cursor: move; user-select: none; touch-action: none; }
    .go { border: 0; background: none; color: #777; font-size: 14px; line-height: 1; padding: 2px 4px; }
    .go:hover, .x:hover { color: #161616; }
  </style>
  <div class="ui">
    <div class="bar">
      <button class="fab" type="button" aria-pressed="false" title="Comment on the page (Alt+C)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M12 8v8M8 12h8"/></svg><span>Comment</span></button>
      <button class="count" type="button" aria-expanded="false" title="All comments"><i></i><span>0</span></button>
    </div>
    <div class="layer"></div>
  </div>`;
  html.appendChild(host);
  const $ = (s) => root.querySelector(s);
  const fab = $('.fab'), countBtn = $('.count'), layer = $('.layer');

  // ---------- state
  let comments = [], picking = false, openId = null, draft = null, listOpen = false, lastJson = '', cardStale = false;
  let showResolved = (() => { try { return localStorage.getItem(LS + 'resolved') === '1'; } catch { return false; } })();
  const onPage = () => comments.filter((c) => c.page === location.pathname && (showResolved || c.status !== 'resolved' || c.id === openId));

  // ---------- API
  const api = async (method, path = '', data) => {
    const r = await fetch(o.route + path, { method, headers: data ? { 'content-type': 'application/json' } : undefined, body: data ? JSON.stringify(data) : undefined });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  };
  const refresh = async () => {
    try {
      const db = await api('GET'); const json = JSON.stringify(db.comments);
      const a = root.activeElement, typing = a && a.tagName === 'TEXTAREA' && !!a.closest('.card.anchored');
      if (json === lastJson) { if (cardStale && openId != null && !typing) { cardStale = false; renderCard(); } for (const [id, f] of floats) if (f.stale && !(a && f.el.contains(a))) { f.stale = false; drawFloat(id); } return; }   // a thread update that arrived while typing is drawn once typing stops
      lastJson = json; comments = (Array.isArray(db.comments) ? db.comments : []).map(clean).filter(Boolean);
      renderPins(); renderCount(); if (listOpen) renderList(); if (openId != null) { if (typing) cardStale = true; else renderCard(); } renderFloats();
    } catch { /* dev server restarting */ }
  };

  // ---------- anchoring: a selector + the click point as a fraction of the element's box
  function selectorFor(el) {
    const uniq = (sel) => { try { const m = document.querySelectorAll(sel); return m.length === 1 && m[0] === el; } catch { return false; } };
    if (el.id && uniq('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== html; n = n.parentElement) {
      if (n !== el && n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); if (uniq(parts.join(' > '))) return parts.join(' > '); break; }
      let part = n.localName;
      const cls = [...n.classList].filter((c) => !/^(astro-|is-|has-|js-|dc-)/.test(c)).slice(0, 2);
      part += cls.map((c) => '.' + CSS.escape(c)).join('');
      const p = n.parentElement;
      if (p) { const same = [...p.children].filter((s) => { try { return s.matches(part); } catch { return false; } }); if (same.length > 1) part += `:nth-of-type(${[...p.children].filter((s) => s.localName === n.localName).indexOf(n) + 1})`; }
      parts.unshift(part);
      if (uniq(parts.join(' > '))) return parts.join(' > ');
    }
    return parts.join(' > ');
  }
  const own = (el) => el.localName + (el.id ? '#' + el.id : '') + [...el.classList].filter((c) => !/^astro-/.test(c)).slice(0, 3).map((c) => '.' + c).join('');
  // an element with no id or class of its own reads better with its parent: "nav.hdr__nav > a"
  const label = (el) => { const me = own(el); return me === el.localName && el.parentElement && el.parentElement !== document.body ? own(el.parentElement) + ' > ' + me : me; };
  function capture(el, x, y) {
    const r = el.getBoundingClientRect();
    const storage = {};
    try { for (let i = 0; i < localStorage.length && Object.keys(storage).length < 80; i++) { const k = localStorage.key(i); if (k.startsWith(LS)) continue; if (o.storagePrefixes && !o.storagePrefixes.some((p) => k.startsWith(p))) continue; storage[k] = String(localStorage.getItem(k)).slice(0, 500); } } catch {}
    const trail = []; for (let n = el.parentElement; n && n !== html && trail.length < 8; n = n.parentElement) trail.push(own(n));
    return {
      page: location.pathname, url: location.pathname + location.search,
      selector: selectorFor(el),
      fx: r.width ? +((x - r.left) / r.width).toFixed(4) : 0, fy: r.height ? +((y - r.top) / r.height).toFixed(4) : 0,
      docX: Math.round(x + scrollX), docY: Math.round(y + scrollY),
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, scrollY: Math.round(scrollY) },
      html: { class: html.className || undefined, data: Object.assign({}, html.dataset), style: html.getAttribute('style') || undefined, darkOS: matchMedia('(prefers-color-scheme: dark)').matches },
      element: { tag: el.localName, id: el.id || undefined, classes: [...el.classList].filter((c) => !/^astro-/.test(c)), label: label(el), text: (el.innerText || el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 200), w: Math.round(r.width), h: Math.round(r.height) },
      trail, storage, userAgent: navigator.userAgent,
    };
  }
  /** where a comment sits right now: { x, y, lost } or null when its element is on the page but hidden */
  function point(c) {
    let el = null; try { el = c.selector && document.querySelector(c.selector); } catch {}
    if (el) { const r = el.getBoundingClientRect(); if (!r.width && !r.height) return null; return { x: r.left + r.width * c.fx, y: r.top + r.height * c.fy, el }; }
    return { x: c.docX - scrollX, y: c.docY - scrollY, lost: true };
  }

  // ---------- pins
  const pins = new Map();
  function renderPins() {
    const want = new Set(onPage().map((c) => c.id));
    for (const [id, b] of pins) if (!want.has(id)) { b.remove(); pins.delete(id); }
    for (const c of onPage()) {
      let b = pins.get(c.id);
      if (!b) { b = document.createElement('button'); b.type = 'button'; b.className = 'pin'; b.addEventListener('click', (e) => { e.stopPropagation(); openThread(c.id); }); layer.appendChild(b); pins.set(c.id, b); }
      b.textContent = c.id; b.classList.toggle('resolved', c.status === 'resolved'); b.classList.toggle('on', c.id === openId);
      b.title = c.text.slice(0, 120);
    }
  }
  function frame() {
    for (const c of onPage()) {
      const b = pins.get(c.id); if (!b) continue;
      const p = point(c);
      if (!p || p.y < -30 || p.y > innerHeight + 30) { b.style.display = 'none'; continue; }
      b.style.display = ''; b.style.left = p.x + 'px'; b.style.top = p.y + 'px'; b.classList.toggle('lost', !!p.lost);
    }
    const card = root.querySelector('.card.anchored');
    if (card && (openId != null || draft)) place(card, openId != null ? point(comments.find((c) => c.id === openId) || {}) : { x: draft.cx - scrollX, y: draft.cy - scrollY });
    requestAnimationFrame(frame);
  }
  const renderCount = () => { const open = comments.filter((c) => c.status !== 'resolved'); countBtn.querySelector('span').textContent = open.length; countBtn.querySelector('i').style.display = open.some((c) => c.page === location.pathname) ? '' : 'none'; };

  // ---------- cards
  function place(card, p) {
    if (!p) { card.style.visibility = 'hidden'; return; }
    card.style.visibility = '';
    const w = card.offsetWidth, h = card.offsetHeight;
    let x = p.x + 18, y = p.y - 20;
    if (x + w > innerWidth - 12) x = p.x - w - 18;
    x = Math.max(12, Math.min(innerWidth - w - 12, x)); y = Math.max(12, Math.min(innerHeight - h - 12, y));
    card.style.left = x + 'px'; card.style.top = y + 'px';
  }
  const closeCard = () => { root.querySelectorAll('.card.anchored').forEach((c) => c.remove()); openId = null; draft = null; renderPins(); };
  function openThread(id) { draft = null; openId = id; renderPins(); renderCard(); const t = root.querySelector('.card.anchored textarea'); if (t && matchMedia('(pointer: fine)').matches) t.focus(); }
  function renderCard() {
    root.querySelectorAll('.card.anchored').forEach((c) => c.remove());
    const c = comments.find((x) => x.id === openId); if (!c) { openId = null; return; }
    const card = document.createElement('div'); card.className = 'card anchored';
    fillThread(card, c, { close: closeCard });
    layer.appendChild(card);
    place(card, point(c));
    const body = card.querySelector('.body'); body.scrollTop = body.scrollHeight;
  }
  /** a thread's header, messages, reply box and buttons, wired; used by the pinned card and the floating windows */
  function fillThread(card, c, { close, float }) {
    const vp = c.viewport ? `${c.viewport.w}×${c.viewport.h}` : '';
    const theme = c.html && c.html.data && c.html.data.theme ? c.html.data.theme : (c.html && c.html.darkOS ? 'OS dark' : 'light');
    const where = float ? (c.page === location.pathname ? 'this page' : c.page) : (c.element ? c.element.label : '');
    card.innerHTML = `<header><b>#${esc(c.id)}</b><span class="tag ${esc(c.status)}">${esc(c.status)}</span><span class="el" title="${esc(c.selector)}">${esc(where)}</span>${float ? '<button class="go" type="button" title="Go to it on its page">↗</button>' : ''}<button class="x" type="button" aria-label="Close">×</button></header>
      <div class="body">
        <div class="msg"><div class="who"><b>${esc(c.author)}</b> · ${esc(ago(c.createdAt))}</div><p>${esc(c.text)}</p></div>
        ${c.replies.map((r) => `<div class="msg ${r.by === o.author ? '' : 'agent'}"><div class="who"><b>${esc(r.by)}</b> · ${esc(ago(r.at))}</div><p>${esc(r.text)}</p></div>`).join('')}
        <div class="meta">${esc(vp)} · ${esc(theme)}${point(c) && point(c).lost ? ' · element not found, pinned by position' : ''}</div>
        <textarea placeholder="Reply…" rows="2"></textarea>
      </div>
      <div class="actions"><button class="btn danger" data-a="del" type="button">Delete</button><button class="btn" data-a="status" type="button">${c.status === 'resolved' ? 'Reopen' : 'Resolve'}</button><button class="btn primary" data-a="reply" type="button" disabled>Reply</button></div>`;
    const ta = card.querySelector('textarea'), replyBtn = card.querySelector('[data-a="reply"]'), del = card.querySelector('[data-a="del"]');
    ta.addEventListener('input', () => { replyBtn.disabled = !ta.value.trim(); });
    const reply = async () => { if (!ta.value.trim()) return; await api('PATCH', '/' + c.id, { reply: { by: o.author, text: ta.value } }); ta.value = ''; lastJson = ''; await refresh(); if (!float) renderCard(); };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) reply(); });
    replyBtn.addEventListener('click', reply);
    card.querySelector('[data-a="status"]').addEventListener('click', async () => { await api('PATCH', '/' + c.id, { status: c.status === 'resolved' ? 'open' : 'resolved' }); lastJson = ''; await refresh(); if (!float) renderCard(); });
    del.addEventListener('click', async () => { if (del.dataset.sure) { await api('DELETE', '/' + c.id); close(); lastJson = ''; refresh(); } else { del.dataset.sure = '1'; del.textContent = 'Delete for good?'; } });
    card.querySelector('.x').addEventListener('click', close);
    const go = card.querySelector('.go'); if (go) go.addEventListener('click', () => { close(); goTo(c.id); });
  }

  // ---------- floating windows: a thread opened from the list without leaving this page ("Open here"); several at
  // once, each dragged by its header, redrawn when the thread changes (unless you are typing in it)
  const floats = new Map();
  let floatN = 0;
  function openFloat(id) {
    const c = comments.find((x) => x.id === id); if (!c) return;
    let f = floats.get(id);
    if (!f) {
      const el = document.createElement('div'); el.className = 'card float';
      const list = root.querySelector('.list'), lr = list && list.getBoundingClientRect();
      const n = floatN++ % 6, w = Math.min(320, innerWidth - 24);
      let x = lr && innerWidth > 760 ? (o.side === 'left' ? lr.right + 12 : lr.left - w - 12) : 12;
      let y = lr && innerWidth > 760 ? lr.top : 12;
      x = Math.max(12, Math.min(innerWidth - w - 12, x + n * 24)); y = Math.max(12, y + n * 24);
      f = { el, x, y }; floats.set(id, f);
      el.style.left = x + 'px'; el.style.top = y + 'px';
      layer.appendChild(el);
      drawFloat(id);
      dragBy(el);
    }
    layer.appendChild(f.el);   // bring to the front
    const t = f.el.querySelector('textarea'); if (t && matchMedia('(pointer: fine)').matches) t.focus();
  }
  const closeFloat = (id) => { const f = floats.get(id); if (f) { f.el.remove(); floats.delete(id); } };
  function drawFloat(id) {
    const f = floats.get(id), c = comments.find((x) => x.id === id);
    if (!c) { closeFloat(id); return; }
    const typed = f.el.querySelector('textarea') && f.el.querySelector('textarea').value;
    fillThread(f.el, c, { close: () => closeFloat(id), float: true });
    if (typed) { const t = f.el.querySelector('textarea'); t.value = typed; t.dispatchEvent(new Event('input')); }
    const body = f.el.querySelector('.body'); body.scrollTop = body.scrollHeight;
    f.el.style.top = Math.max(12, Math.min(innerHeight - f.el.offsetHeight - 12, parseFloat(f.el.style.top))) + 'px';
  }
  function dragBy(el) {
    el.addEventListener('pointerdown', (e) => {
      const head = e.target.closest('header'); if (!head || e.target.closest('button')) return;
      e.preventDefault(); head.setPointerCapture(e.pointerId);
      const dx = e.clientX - el.offsetLeft, dy = e.clientY - el.offsetTop;
      layer.appendChild(el);
      const move = (m) => { el.style.left = Math.max(0, Math.min(innerWidth - 60, m.clientX - dx)) + 'px'; el.style.top = Math.max(0, Math.min(innerHeight - 40, m.clientY - dy)) + 'px'; };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', () => head.removeEventListener('pointermove', move), { once: true });
    });
  }
  function renderFloats() {
    for (const id of [...floats.keys()]) {
      const f = floats.get(id), active = root.activeElement;
      if (active && f.el.contains(active) && active.tagName === 'TEXTAREA') { f.stale = true; continue; }
      f.stale = false; drawFloat(id);
    }
  }
  function openComposer(el, x, y) {
    closeCard();
    draft = Object.assign(capture(el, x, y), { cx: x + scrollX, cy: y + scrollY });
    const card = document.createElement('div'); card.className = 'card anchored';
    card.innerHTML = `<header><b>New comment</b><span class="el" title="${esc(draft.selector)}">${esc(draft.element.label)}</span><button class="x" type="button" aria-label="Cancel">×</button></header>
      <div class="body"><textarea placeholder="What should change here?" rows="3"></textarea><div class="meta">${esc(draft.viewport.w)}×${esc(draft.viewport.h)} · ⌘/Ctrl + Enter to save</div></div>
      <div class="actions"><button class="btn" data-a="cancel" type="button">Cancel</button><button class="btn accent" data-a="save" type="button" disabled>Comment</button></div>`;
    layer.appendChild(card);
    const ta = card.querySelector('textarea'), save = card.querySelector('[data-a="save"]');
    ta.addEventListener('input', () => { save.disabled = !ta.value.trim(); });
    const submit = async () => {
      if (!ta.value.trim()) return; save.disabled = true;
      try { const { cx, cy, ...data } = draft; const c = await api('POST', '', Object.assign(data, { text: ta.value })); draft = null; card.remove(); lastJson = ''; await refresh(); openThread(c.id); }
      catch (e) { save.disabled = false; save.textContent = 'Retry'; card.querySelector('.meta').textContent = 'Could not save: ' + e.message; }
    };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); });
    save.addEventListener('click', submit);
    card.querySelector('[data-a="cancel"]').addEventListener('click', closeCard); card.querySelector('.x').addEventListener('click', closeCard);
    place(card, { x, y }); ta.focus();
  }

  // ---------- list of every comment, grouped by page
  function renderList() {
    root.querySelectorAll('.list').forEach((l) => l.remove());
    if (!listOpen) return;
    const box = document.createElement('div'); box.className = 'list';
    const shown = comments.filter((c) => showResolved || c.status !== 'resolved').sort((a, b) => (a.page === location.pathname ? -1 : 0) - (b.page === location.pathname ? -1 : 0) || a.page.localeCompare(b.page) || b.id - a.id);
    const pages = [...new Set(shown.map((c) => c.page))];
    box.innerHTML = `<header><b>Comments</b><label><input type="checkbox" ${showResolved ? 'checked' : ''}> Show resolved</label><button class="x" type="button" aria-label="Close">×</button></header>
      <div class="rows">${pages.length ? pages.map((p) => `<h4>${esc(p)}${p === location.pathname ? ' · this page' : ''}</h4>` + shown.filter((c) => c.page === p).map((c) => `<div class="row-wrap"><button class="row ${esc(c.status)}" type="button" data-id="${esc(c.id)}"><span class="n">${esc(c.id)}</span><span class="t">${esc(c.text)}</span><span class="m">${c.replies.length ? c.replies.length + (c.replies.length === 1 ? ' reply' : ' replies') + ' · ' : ''}${c.viewport ? esc(c.viewport.w) + 'px · ' : ''}${esc(ago(c.createdAt))}</span></button><button class="here" type="button" data-here="${esc(c.id)}" title="Open the thread in a window here, without going to its page">Open here</button></div>`).join('')).join('') : '<div class="empty">No comments yet. Press Comment, then click anything on the page.</div>'}</div>`;
    layer.appendChild(box);
    box.querySelector('.x').addEventListener('click', () => toggleList(false));
    box.querySelector('input').addEventListener('change', (e) => { showResolved = e.target.checked; try { localStorage.setItem(LS + 'resolved', showResolved ? '1' : '0'); } catch {} renderPins(); renderList(); });
    box.querySelectorAll('.row').forEach((r) => r.addEventListener('click', () => goTo(Number(r.dataset.id))));
    box.querySelectorAll('.here').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openFloat(Number(b.dataset.here)); }));
  }
  const toggleList = (v) => { listOpen = v == null ? !listOpen : v; countBtn.setAttribute('aria-expanded', String(listOpen)); renderList(); };
  function goTo(id) {
    const c = comments.find((x) => x.id === id); if (!c) return;
    if (c.page !== location.pathname) {
      // only ever a page of this site: the url came from whoever wrote the comment
      const to = new URL(sitePath(c.url) || c.page, location.origin);
      if (to.origin === location.origin) location.href = to.pathname + to.search + '#dc=' + id;
      return;
    }
    const p = point(c); if (p && p.el) p.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); else if (p) scrollTo({ top: c.docY - innerHeight / 2, behavior: 'smooth' });
    if (window.innerWidth <= 760) toggleList(false);
    setTimeout(() => openThread(id), 350);
  }

  // ---------- pick mode
  const outline = document.createElement('div'); outline.className = 'outline'; outline.innerHTML = '<span></span>'; outline.style.display = 'none';
  const banner = document.createElement('div'); banner.className = 'banner'; banner.innerHTML = 'Click anything to comment · <b>Esc</b> to stop'; banner.style.display = 'none';
  layer.append(outline); root.querySelector('.bar').append(banner);
  const cursor = document.createElement('style'); cursor.textContent = 'html.dc-picking, html.dc-picking * { cursor: crosshair !important; }'; document.head.appendChild(cursor);
  const fromUs = (e) => e.composedPath().includes(host);
  function setPicking(v) {
    picking = v; fab.setAttribute('aria-pressed', String(v)); html.classList.toggle('dc-picking', v);
    banner.style.display = v ? '' : 'none'; if (!v) outline.style.display = 'none';
    if (v) { closeCard(); toggleList(false); }
  }
  const targetAt = (e) => { const el = document.elementFromPoint(e.clientX, e.clientY); return el && el !== html && el !== document.body && !host.contains(el) && el !== host ? el : null; };
  window.addEventListener('pointermove', (e) => {
    if (!picking || fromUs(e)) return;
    const el = targetAt(e); if (!el) { outline.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(outline.style, { display: '', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    outline.classList.toggle('below', r.top < 26); outline.querySelector('span').textContent = `${label(el)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
  }, true);
  const swallow = (e) => { if (picking && !fromUs(e)) { e.preventDefault(); e.stopImmediatePropagation(); } };
  // touchstart/touchend stay untouched: cancelling them would also cancel the tap's click on phones
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'contextmenu', 'submit'].forEach((t) => window.addEventListener(t, swallow, { capture: true, passive: false }));
  window.addEventListener('click', (e) => {
    if (!picking || fromUs(e)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const el = targetAt(e); if (!el) return;
    setPicking(false); openComposer(el, e.clientX, e.clientY);
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (picking) setPicking(false); else if (draft || openId != null) closeCard(); else if (listOpen) toggleList(false); }
    if (e.altKey && e.code === 'KeyC') { e.preventDefault(); setPicking(!picking); }
  }, true);
  fab.addEventListener('click', () => setPicking(!picking));
  countBtn.addEventListener('click', () => { setPicking(false); toggleList(); });

  // ---------- go
  refresh().then(() => { const m = /#dc=(\d+)/.exec(location.hash); if (m) { history.replaceState(null, '', location.pathname + location.search); setTimeout(() => goTo(Number(m[1])), 600); } });
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 4000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  requestAnimationFrame(frame);
  window.__devComments = { refresh, pick: () => setPicking(true), open: goTo };
  return window.__devComments;
}
