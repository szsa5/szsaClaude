"""
Comment review board (/commentreview in the dev-comments skill): one self-contained HTML page for an artifact.

    uv run --with pillow python render_board.py board.json out.html

board.json:
{
  "title": "Staging comments",                 # the page's name (h1 and <title>)
  "subtitle": "…one or two sentences…",
  "comments": "path/to/comments.json",         # the dev-comments store ({next, comments[]}), full text + replies
  "shots": "path/to/.dev-comments/shots",      # <id>.png = now, before/<id>.png = before (either may be missing)
  "items": [                                   # one per unresolved comment
    {"id": 4, "category": 1, "where": "What was done / what is missing, plain words."},
    {"id": 11, "category": "dev", "where": "…", "labels": ["Staging now", "On dev"]},   # optional shot captions
    …
  ],
  "questions": [                               # category 3: choices for the owner (html allowed in body)
    {"qid": "q-cards-move", "ref": "#27 · #30", "title": "…", "body": "<b>A</b> … (recommended); <b>B</b> …"}
  ],
  "misc": ["html line", …]                     # category 5
}
Categories: 1 implemented and live on staging, comment still open (confirm) · "dev" built on the local dev server,
not on staging yet · 2 waiting for someone · 3 needs your answer (the questions) · 4 clear, not built yet.
"local": {"title": …, "items": [html…]} adds a separate block for the local (localhost-only) comments, which the
staging commenters cannot see; never mix them with the staging comments. Each comment card quotes the comment and every reply IN FULL.
Answer boxes save to the artifact db, collection "answers": doc "c<id>" per comment, "q-…" per question,
{text, images: [asset ids]}. Boxes grow with their text; pasted or dropped images go to the asset store
(board-answers.js). Publish with capabilities {"db": {}, "assets": {}}.
"""
import base64, html, io, json, os, sys
from PIL import Image

data = json.load(open(sys.argv[1]))
store = {c['id']: c for c in json.load(open(data['comments']))['comments']}
shots = data.get('shots', '')
E = html.escape


def img(path):
    if not path or not os.path.exists(path):
        return None
    im = Image.open(path).convert('RGB')
    w = 300
    im = im.resize((w, int(im.height * w / im.width)))
    if im.height > 620:
        im = im.crop((0, 0, w, 620))
    b = io.BytesIO()
    im.save(b, 'JPEG', quality=68)
    return 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode()


def box(qid, label):
    return (f'<div class="ans" data-q="{qid}"><label for="a-{qid}">{label}</label>'
            f'<textarea id="a-{qid}" disabled placeholder="Loading…"></textarea><span class="state"></span></div>')


def card(item):
    c = store[item['id']]
    text = E(c['text']).replace('\n', '<br>')
    who = E(c.get('author') or 'Comment')
    out = [f'<article class="c"><div class="c-head"><span class="num">#{c["id"]}</span>'
           f'<span class="route">{E(c.get("page") or "")}</span></div><div class="c-body"><div class="txt">',
           f'<p class="said"><b>{who} wrote ({c["createdAt"][:10]}):</b> {text}</p>']
    for r in c.get('replies', []):
        out.append(f'<p class="said reply"><b>{E(r.get("by", "?"))} replied:</b> {E(r["text"]).replace(chr(10), "<br>")}</p>')
    out.append(f'<p class="st">{item["where"]}</p>')
    out.append(box(f'c{c["id"]}', 'Your answer: "resolve", or a reply (posted in your name). Paste screenshots straight in.'))
    out.append('</div><div class="shots">')
    labels = item.get('labels', ['Before', 'Now'])
    for label, p in ((labels[0], os.path.join(shots, 'before', f'{c["id"]}.png')), (labels[1], os.path.join(shots, f'{c["id"]}.png'))):
        src = img(p)
        if src:
            out.append(f'<figure><figcaption>{label}</figcaption><img src="{src}" alt=""></figure>')
    out.append('</div></div></article>')
    return ''.join(out)


NAMES = {1: 'Implemented and live on staging, comment still open: confirm',
         'dev': 'Built on dev (localhost), not on staging yet', 2: 'Waiting for the client / someone', 4: 'Clear, not built yet'}
LABEL = {1: '1', 'dev': '1b', 2: '2'}
parts = [f'<div class="wrap"><h1>{E(data["title"])}</h1><p class="sub">{data.get("subtitle", "")}</p>']
for cat in (1, 'dev', 2):
    items = [i for i in data['items'] if i['category'] == cat]
    if not items and cat == 'dev':
        continue
    parts.append(f'<div class="grp"><h2>{LABEL[cat]} · {NAMES[cat]}</h2><span class="count">{len(items)}</span></div>')
    parts += [card(i) for i in items]
qs = data.get('questions', [])
parts.append(f'<div class="grp"><h2>3 · Needs your answer</h2><span class="count">{len(qs)}</span></div>')
for q in qs:
    parts.append(f'<div class="q"><h3><span class="ref">{E(q.get("ref", ""))}</span>{E(q["title"])}</h3><p>{q["body"]}</p>'
                 f'{box(q["qid"], "Your answer")}</div>')
items = [i for i in data['items'] if i['category'] == 4]
parts.append(f'<div class="grp"><h2>4 · {NAMES[4]}</h2><span class="count">{len(items)}</span></div>')
parts += [card(i) for i in items]
if data.get('local'):
    loc = data['local']
    parts.append(f'<div class="grp local"><h2>{E(loc.get("title", "Local comments (localhost only)"))}</h2></div>'
                 '<ul class="plain local">' + ''.join(f'<li>{m}</li>' for m in loc['items']) + '</ul>')
if data.get('misc'):
    parts.append('<div class="grp"><h2>5 · Misc</h2></div><ul class="plain">' + ''.join(f'<li>{m}</li>' for m in data['misc']) + '</ul>')
parts.append('</div>')

CSS = """<title>%s</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap">
<style>
  :root { color-scheme: dark; --bg: #0d0d0d; --ink: #000; --fg: #f2efeb; --muted: #a49d95; --line: #2a2826; --line2: #3b3835; --orange: #f98829; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 Montserrat, "Helvetica Neue", Arial, sans-serif; }
  .wrap { max-width: 1100px; margin: 0 auto; padding-inline: 20px; padding-block: 44px 90px; }
  h1 { font-size: 30px; margin: 0 0 8px; text-wrap: balance; }
  .sub { color: var(--muted); max-width: 76ch; }
  h2 { font-size: 12px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--orange); margin: 0; }
  .grp { margin: 50px 0 10px; display: flex; gap: 12px; align-items: baseline; }
  .count { color: var(--muted); font-size: 13px; }
  .route { font: 12.5px ui-monospace, Menlo, monospace; color: var(--orange); }
  .c, .q { border: 1px solid var(--line2); background: var(--ink); margin: 12px 0; }
  .c-head { display: flex; gap: 12px; align-items: baseline; padding: 10px 14px; border-bottom: 1px solid var(--line); }
  .num { font-weight: 700; color: var(--orange); }
  .c-body { display: grid; grid-template-columns: 1fr auto; gap: 16px; padding: 12px 14px; }
  .said { font-size: 14px; color: #e8dcc4; margin: 0 0 8px; max-width: 70ch; }
  .said.reply { color: #c9bda6; padding-left: 12px; border-left: 2px solid var(--line2); }
  .st { font-size: 14px; margin: 0 0 10px; } .st::before { content: "Where it stands: "; color: var(--orange); font-weight: 600; }
  .shots { display: flex; gap: 10px; } .shots figure { margin: 0; width: 150px; }
  .shots img { width: 150px; display: block; border: 1px solid var(--line); }
  .shots figcaption { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-bottom: 4px; }
  .q { padding: 12px 14px; } .q h3 { font-size: 16px; margin: 0 0 6px; } .ref { color: var(--orange); margin-right: 8px; }
  .q p { font-size: 14px; }
  ul.plain { padding-left: 20px; }
  .grp.local { border-top: 1px dashed var(--line2); padding-top: 24px; } .grp.local h2 { color: #7fb3ff; }
  .opts { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; margin: 12px 0; }
  .opts figure { margin: 0; } .opts img { width: 100%%; display: block; border: 1px solid var(--line); }
  .opts figcaption { font-size: 12.5px; color: var(--muted); margin-top: 6px; } .opts figcaption b { color: var(--fg); } ul.plain li { margin-bottom: 6px; }
  .ans label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  .ans textarea { width: 100%%; min-height: 40px; resize: none; overflow: hidden; field-sizing: content; padding: 9px 11px; border: 0; border-radius: 4px; background: rgba(255,255,255,.05); box-shadow: inset 0 0 0 1px var(--line2); color: var(--fg); font: 14px/1.5 Montserrat, sans-serif; }
  .ans textarea:focus { outline: none; box-shadow: inset 0 0 0 1px var(--orange); }
  .ans .thumbs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; } .ans .thumbs:empty { display: none; }
  .ans .thumbs figure { position: relative; margin: 0; } .ans .thumbs span { font-size: 12px; color: var(--muted); }
  .ans .thumbs img { display: block; max-width: 220px; max-height: 160px; border: 1px solid var(--line2); border-radius: 4px; }
  .ans .thumbs button { position: absolute; top: 4px; right: 4px; width: 24px; height: 24px; border: 0; border-radius: 50%%; background: rgba(0,0,0,.75); color: #fff; font: 16px/24px sans-serif; cursor: pointer; }
  .ans .thumbs button:hover { background: var(--orange); }
  .ans .state { display: block; min-height: 1.2em; font-size: 12px; color: var(--muted); }
  @media (max-width: 760px) { .c-body { grid-template-columns: 1fr; } .shots figure, .shots img { width: 130px; } }
</style>""" % E(data['title'])

JS = '<script>\n' + open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'board-answers.js')).read() + '</script>'

open(sys.argv[2], 'w').write(CSS + '\n' + '\n'.join(parts) + '\n' + JS)
print('board:', sys.argv[2], len([i for i in data['items']]), 'comments,', len(qs), 'questions')
