// Answer boxes of the comment review board (/commentreview). Each `[data-q]` holds a textarea; its answer is one db
// doc `answers/<qid>`: {text, images: [assetId…], question, at}. Boxes grow with their text; pasting (or dropping)
// images uploads them to the artifact's asset store and shows them as thumbnails under the box (× removes one).
// Needs capabilities {db: {}, assets: {}}; without assets (a read-only view) text still works, images are shown only.
(async () => {
  const areas = [...document.querySelectorAll('[data-q] textarea')];
  const grow = (ta) => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
  areas.forEach((ta) => { ta.addEventListener('input', () => grow(ta)); grow(ta); });
  const note = (ta, t) => { ta.parentElement.querySelector('.state').textContent = t; };
  const db = await (window.claude?.use ? window.claude.use('db') : null);
  if (!db) { areas.forEach((ta) => { ta.placeholder = 'Answers save when this page is opened on claude.ai while signed in.'; }); return; }
  const assets = await (window.claude?.use ? window.claude.use('assets') : null);

  areas.forEach((ta) => {
    const id = ta.closest('[data-q]').dataset.q;
    const ref = db.doc('answers/' + id);
    const thumbs = document.createElement('div');
    thumbs.className = 'thumbs';
    ta.insertAdjacentElement('afterend', thumbs);
    let saved = '', images = [], timer = 0, busy = false, again = false;
    ta.disabled = false;
    ta.placeholder = assets ? 'Type here, or paste a screenshot; it saves by itself.' : 'Type here; it saves by itself.';

    const draw = () => {
      thumbs.replaceChildren(...images.map((a) => {
        const f = document.createElement('figure');
        const img = document.createElement('img');
        img.src = '/_blob/' + a; img.alt = 'Pasted image';
        img.addEventListener('error', () => { img.replaceWith(Object.assign(document.createElement('span'), { textContent: 'image removed' })); });
        f.append(img);
        if (assets) {
          const x = document.createElement('button');
          x.type = 'button'; x.textContent = '×'; x.title = 'Remove this image';
          x.addEventListener('click', async () => {
            images = images.filter((i) => i !== a); draw(); await write();
            try { await assets.delete(a); } catch { /* the pointer is gone either way */ }
          });
          f.append(x);
        }
        return f;
      }));
    };

    const write = async () => {
      busy = true; note(ta, 'Saving…');
      try {
        const text = ta.value.trim();
        await ref.set({ text, images, question: id, at: new Date().toISOString() });
        saved = text; note(ta, 'Saved');
      } catch (e) { note(ta, e && e.code === 'permission_denied' ? 'Only editors can answer here.' : 'Not saved, try again.'); }
      busy = false;
      if (again) { again = false; save(); }
    };
    const save = async () => {
      if (busy) { again = true; return; }
      if (ta.value.trim() === saved) return;
      await write();
    };

    ref.onSnapshot((s) => {
      const d = s.exists ? s.data() : {};
      saved = d.text || '';
      images = Array.isArray(d.images) ? d.images : [];
      if (document.activeElement !== ta) { ta.value = saved; grow(ta); }
      draw();
    }, () => note(ta, 'Could not load the saved answer.'));

    const upload = async (files) => {
      if (!assets) { note(ta, 'Images can only be added by the page owner.'); return; }
      for (const file of files) {
        note(ta, 'Uploading image…');
        try {
          const r = await assets.upload(file);
          images = [...images, r.id]; draw(); await write();
        } catch (e) {
          note(ta, { too_large: 'Image too large (max 20 MB).', unsupported_type: 'Only PNG, JPEG, GIF or WebP images.', rate_limited: 'Too many uploads, wait a moment.' }[e?.code] || 'Image not saved, try again.');
        }
      }
    };
    const imagesOf = (list) => [...(list || [])].filter((f) => f && f.type && f.type.startsWith('image/'));
    ta.addEventListener('paste', (e) => {
      const files = imagesOf([...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()));
      if (files.length) { e.preventDefault(); upload(files); }   // plain text pastes as usual
    });
    ta.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) e.preventDefault(); });
    ta.addEventListener('drop', (e) => {
      const files = imagesOf(e.dataTransfer?.files);
      if (files.length) { e.preventDefault(); upload(files); }
    });
    ta.addEventListener('input', () => { clearTimeout(timer); note(ta, ''); timer = setTimeout(save, 900); });
    ta.addEventListener('blur', () => { clearTimeout(timer); save(); });
  });
})();
