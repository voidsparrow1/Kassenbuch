/* Kassenbuch – Kassenzettel fotografieren, auslesen, als Excel teilen. */
(function () {
  'use strict';
  const P = window.BonParser;
  const $ = (id) => document.getElementById(id);

  // ---------- Felder (hier später erweitern, z. B. MwSt, Kategorie) ----------
  const FIELDS = [
    { key: 'datum', title: 'Datum', type: 'date', width: 12 },
    { key: 'haendler', title: 'Händler', type: 'text', width: 30 },
    { key: 'betrag', title: 'Betrag', type: 'money', width: 13 }
  ];
  const REQUIRED = ['datum', 'betrag'];

  const USE_SW = 'serviceWorker' in navigator && !/[?&]nosw\b/.test(location.search);
  const abs = (p) => new URL(p, location.href).href;

  // ---------- Speicher (IndexedDB, bleibt auf dem Gerät) ----------
  let dbP = null;
  function db() {
    if (!dbP) dbP = new Promise((res, rej) => {
      const r = indexedDB.open('kassenbuch', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('eintraege', { keyPath: 'id', autoIncrement: true });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbP;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction('eintraege', mode);
      const req = fn(t.objectStore('eintraege'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  }
  const allEntries = () => tx('readonly', (s) => s.getAll());
  const saveEntry = (e) => tx('readwrite', (s) => s.put(e));
  const deleteEntry = (id) => tx('readwrite', (s) => s.delete(id));

  // ---------- Hilfen ----------
  const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const eur = (c) => P.formatCents(c || 0) + ' €';
  const deDate = (iso) => iso ? iso.split('-').reverse().join('.') : '';
  const todayIso = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.h);
    toast.h = setTimeout(() => { t.hidden = true; }, ms || 2600);
  }
  function setBar(id, frac) { $(id).style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%'; }

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('Konnte ' + src + ' nicht laden'));
      document.head.appendChild(s);
    });
  }

  // ---------- Liste ----------
  async function render() {
    const entries = (await allEntries()).sort((a, b) => (b.datum || '').localeCompare(a.datum || '') || b.id - a.id);
    const list = $('list');
    const now = todayIso().slice(0, 7);
    const monthSum = entries.filter((e) => (e.datum || '').startsWith(now)).reduce((a, e) => a + (e.betrag || 0), 0);
    $('monthLabel').textContent = MONTHS[new Date().getMonth()];
    $('monthSum').textContent = eur(monthSum);

    if (!entries.length) {
      list.innerHTML = '<div class="empty"><b>Noch keine Einträge</b>Tippe unten auf „Kassenzettel fotografieren“.</div>';
      return;
    }
    const groups = {};
    for (const e of entries) (groups[(e.datum || '????-??').slice(0, 7)] ||= []).push(e);

    list.innerHTML = '';
    for (const key of Object.keys(groups)) {
      const items = groups[key];
      const [y, m] = key.split('-');
      const head = document.createElement('div');
      head.className = 'group';
      head.innerHTML = '<span></span><span></span>';
      head.children[0].textContent = (MONTHS[+m - 1] || 'Ohne Datum') + (y && y !== '????' ? ' ' + y : '');
      head.children[1].textContent = eur(items.reduce((a, e) => a + (e.betrag || 0), 0));
      list.appendChild(head);
      for (const e of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'entry';
        b.innerHTML = '<span class="who"></span><span class="amt"></span><span class="when"></span>';
        b.querySelector('.who').textContent = e.haendler || 'Ohne Händler';
        b.querySelector('.amt').textContent = eur(e.betrag);
        b.querySelector('.when').textContent = deDate(e.datum);
        b.addEventListener('click', () => openEditor(e, { existing: true }));
        list.appendChild(b);
      }
    }
  }

  // ---------- Bearbeiten / Prüfen ----------
  let editing = null;

  function openEditor(entry, opts) {
    opts = opts || {};
    editing = Object.assign({}, entry);
    $('editorTitle').textContent = opts.existing ? 'Eintrag bearbeiten' : opts.manual ? 'Neuer Eintrag' : 'Bitte kurz prüfen';
    const missing = opts.existing || opts.manual ? [] : FIELDS.filter((f) => !entry[f.key]).map((f) => f.key);
    $('editorHint').textContent = opts.existing || opts.manual ? '' :
      missing.length ? 'Orange markierte Felder bitte ergänzen.' :
      opts.quelle === 'qr' ? 'Betrag und Datum stammen aus dem QR-Code des Bons.' : 'Stimmt alles? Dann einfach speichern.';
    $('deleteBtn').hidden = !opts.existing;

    const box = $('fields');
    box.innerHTML = '';
    for (const f of FIELDS) {
      const wrap = document.createElement('div');
      wrap.className = 'field' + (missing.includes(f.key) ? ' missing' : '');
      const id = 'f_' + f.key;
      const label = document.createElement('label');
      label.htmlFor = id; label.textContent = f.title + (f.type === 'money' ? ' (€)' : '');
      const input = document.createElement('input');
      input.id = id; input.name = f.key;
      if (f.type === 'date') { input.type = 'date'; input.value = entry[f.key] || ''; }
      else if (f.type === 'money') {
        input.type = 'text'; input.inputMode = 'decimal'; input.className = 'money';
        input.placeholder = '0,00'; input.value = entry[f.key] ? P.formatCents(entry[f.key]) : '';
      } else { input.type = 'text'; input.autocapitalize = 'words'; input.value = entry[f.key] || ''; }
      input.addEventListener('input', () => wrap.classList.remove('missing'));
      wrap.append(label, input);
      if (missing.includes(f.key)) {
        const n = document.createElement('div'); n.className = 'note'; n.textContent = 'Nicht erkannt';
        wrap.appendChild(n);
      }
      box.appendChild(wrap);
    }
    $('editor').hidden = false;
  }

  function closeEditor() { $('editor').hidden = true; editing = null; }

  function readMoney(v) {
    v = String(v || '').trim().replace(/\s|€/g, '');
    if (!v) return null;
    if (/^-?\d+$/.test(v)) v += ',00';
    if (/^-?\d+[.,]\d$/.test(v)) v += '0';
    return P.toCents(v);
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    const out = Object.assign({}, editing);
    let ok = true;
    for (const f of FIELDS) {
      const input = $('f_' + f.key);
      let v = input.value.trim();
      if (f.type === 'money') { v = readMoney(v); if (v === null && input.value.trim()) { mark(input, 'Bitte als Betrag eingeben, z. B. 12,50'); ok = false; continue; } }
      if (REQUIRED.includes(f.key) && (v === null || v === '')) { mark(input, 'Bitte ausfüllen'); ok = false; continue; }
      out[f.key] = v === '' ? null : v;
    }
    if (!ok) return;
    if (!out.erstellt) out.erstellt = new Date().toISOString();
    await saveEntry(out);
    closeEditor();
    await render();
    toast('Gespeichert');
  }

  function mark(input, msg) {
    const wrap = input.parentElement;
    wrap.classList.add('missing');
    let n = wrap.querySelector('.note');
    if (!n) { n = document.createElement('div'); n.className = 'note'; wrap.appendChild(n); }
    n.textContent = msg;
  }

  // ---------- Texterkennung ----------
  let workerP = null;
  let onProgress = () => {};
  let vendorP = null;

  function loadVendor() {
    if (!vendorP) vendorP = Promise.all([loadScript('vendor/jsQR.js'), loadScript('vendor/tesseract.min.js')])
      .catch((e) => { vendorP = null; throw e; });
    return vendorP;
  }

  function getWorker() {
    if (!workerP) {
      workerP = (async () => {
        await loadVendor();
        const w = await window.Tesseract.createWorker('deu', 1, {
          workerPath: abs('vendor/worker.min.js'),
          corePath: abs('vendor/core'),
          langPath: abs('vendor/lang'),
          workerBlobURL: false,
          logger: (m) => { if (m.status === 'recognizing text') onProgress(m.progress); }
        });
        await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
        return w;
      })().catch((e) => { workerP = null; throw e; });
    }
    return workerP;
  }

  function loadImg(file) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('Bild konnte nicht geöffnet werden'));
      img.src = URL.createObjectURL(file);
    });
  }

  function drawScaled(img, maxSide) {
    const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  // Graustufen + Kontrast strecken: hilft bei blassem Thermopapier
  function enhance(canvas) {
    const ctx = canvas.getContext('2d');
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = d.data, hist = new Uint32Array(256);
    for (let i = 0; i < px.length; i += 4) {
      const g = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 | 0;
      px[i] = g; hist[g]++;
    }
    const n = px.length / 4;
    let lo = 0, hi = 255, acc = 0;
    while (lo < 255 && (acc += hist[lo]) < n * 0.02) lo++;
    acc = 0;
    while (hi > 0 && (acc += hist[hi]) < n * 0.10) hi--;
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < px.length; i += 4) {
      const v = Math.max(0, Math.min(255, (px[i] - lo) * 255 / span));
      px[i] = px[i + 1] = px[i + 2] = v;
    }
    ctx.putImageData(d, 0, 0);
    return canvas;
  }

  function scanQr(canvas) {
    if (!window.jsQR) return null;
    try {
      const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(d.data, d.width, d.height, { inversionAttempts: 'dontInvert' });
      return code ? P.parseTseQr(code.data) : null;
    } catch (e) { return null; }
  }

  async function processFile(file) {
    if (!file) return;
    const img = await loadImg(file);
    $('busyImg').src = img.src;
    $('busyText').textContent = 'Kassenzettel wird gelesen …';
    setBar('busyBar', 0.03);
    $('busy').hidden = false;

    let result = {};
    try {
      onProgress = (p) => setBar('busyBar', 0.1 + p * 0.9);
      await loadVendor();
      const big = drawScaled(img, 2000);
      const qr = scanQr(big);
      setBar('busyBar', 0.08);
      const ocrCanvas = enhance(drawScaled(img, 1600));
      const worker = await getWorker();
      const { data } = await worker.recognize(ocrCanvas);
      result = P.combine(P.parseOcrText(data.text), qr);
    } catch (e) {
      console.error(e);
      toast('Automatisches Lesen hat nicht geklappt – bitte von Hand eintragen.', 4000);
      result = {};
    } finally {
      $('busy').hidden = true;
      URL.revokeObjectURL(img.src);
    }
    openEditor({ datum: result.datum, haendler: result.haendler, betrag: result.betrag }, { quelle: result.quelle });
  }

  // ---------- Excel ----------
  async function exportExcel() {
    const entries = (await allEntries()).sort((a, b) => (a.datum || '').localeCompare(b.datum || '') || a.id - b.id);
    if (!entries.length) { toast('Noch keine Einträge zum Exportieren'); return; }
    const blob = window.XlsxLite.build(FIELDS, entries, { sheetName: 'Kassenbuch' });
    const name = 'Kassenbuch_' + todayIso() + '.xlsx';
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Kassenbuch' }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // ---------- Start / Offline-Einrichtung ----------
  async function setupOffline() {
    if (!USE_SW) return;
    navigator.serviceWorker.addEventListener('message', (ev) => {
      if (ev.data && ev.data.type === 'setup-progress') setBar('setupBar', ev.data.done / ev.data.total);
    });
    const reg = await navigator.serviceWorker.register('sw.js');
    if (navigator.serviceWorker.controller) return; // schon eingerichtet

    $('setup').hidden = false;
    setBar('setupBar', 0.02);
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
      const w = reg.installing || reg.waiting;
      if (w) w.addEventListener('statechange', () => {
        if (w.state === 'redundant') {
          $('setupText').textContent = 'Für die Einrichtung wird einmalig Internet benötigt. Bitte mit dem Internet verbinden und die App neu öffnen.';
          setBar('setupBar', 0);
        }
      });
    });
    $('setup').hidden = true;
    toast('Fertig eingerichtet – ab jetzt geht alles offline.', 3500);
  }

  function wire() {
    const onPick = (ev) => { const f = ev.target.files[0]; ev.target.value = ''; processFile(f); };
    $('camInput').addEventListener('change', onPick);
    $('galleryInput').addEventListener('change', onPick);
    $('manualBtn').addEventListener('click', () => openEditor({ datum: todayIso() }, { manual: true }));
    $('exportBtn').addEventListener('click', exportExcel);
    $('form').addEventListener('submit', onSubmit);
    $('cancelBtn').addEventListener('click', closeEditor);
    $('deleteBtn').addEventListener('click', async () => {
      if (!editing || !editing.id) return;
      if (!confirm('Diesen Eintrag wirklich löschen?')) return;
      await deleteEntry(editing.id);
      closeEditor(); await render(); toast('Gelöscht');
    });
  }

  async function start() {
    wire();
    await render();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    try { await setupOffline(); } catch (e) { console.error(e); }
    // Texterkennung im Hintergrund vorwärmen, damit der erste Scan schneller geht
    setTimeout(() => getWorker().catch(() => {}), 1500);
  }

  start();
})();
