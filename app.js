/* Kassenbuch – Kassenabrechnung fotografieren, Kassenbestand führen, als Excel teilen. */
(function () {
  'use strict';
  const P = window.BonParser;
  const K = window.Kassenbuch;
  const $ = (id) => document.getElementById(id);

  const APP_VERSION = 11;   // sichtbar unten in der Liste – zum Prüfen, ob ein Update angekommen ist
  const USE_SW = 'serviceWorker' in navigator && !/[?&]nosw\b/.test(location.search);
  const abs = (p) => new URL(p, location.href).href;

  // ---------- Speicher (IndexedDB, bleibt auf dem Gerät) ----------
  let dbP = null;
  function db() {
    if (!dbP) dbP = new Promise((res, rej) => {
      const r = indexedDB.open('kassenbuch', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('eintraege')) d.createObjectStore('eintraege', { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains('einstellungen')) d.createObjectStore('einstellungen', { keyPath: 'key' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbP;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  }
  const allEntries = () => tx('eintraege', 'readonly', (s) => s.getAll());
  const saveEntry = (e) => tx('eintraege', 'readwrite', (s) => s.put(e));
  const deleteEntry = (id) => tx('eintraege', 'readwrite', (s) => s.delete(id));
  const getSetting = async (key) => { const r = await tx('einstellungen', 'readonly', (s) => s.get(key)); return r ? r.value : null; };
  const setSetting = (key, value) => tx('einstellungen', 'readwrite', (s) => s.put({ key: key, value: value }));

  // ---------- Hilfen ----------
  const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const eur = (c) => P.formatCents(c || 0) + ' €';
  const deDate = (iso) => iso ? iso.split('-').reverse().join('.') : '';
  const dayLabel = (iso) => { const d = new Date(iso + 'T12:00:00'); return isNaN(d) ? 'Ohne Datum' : WD[d.getDay()] + ', ' + deDate(iso); };
  const todayIso = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.h);
    toast.h = setTimeout(() => { t.hidden = true; }, ms || 2600);
  }
  function setBar(id, frac) { $(id).style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%'; }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('Konnte ' + src + ' nicht laden'));
      document.head.appendChild(s);
    });
  }

  function readMoney(v) {
    v = String(v || '').trim().replace(/\s|€/g, '');
    if (!v) return null;
    if (/^-?\d+$/.test(v)) v += ',00';
    if (/^-?\d+[.,]\d$/.test(v)) v += '0';
    return P.toCents(v);
  }

  // ---------- Zustand ----------
  let ENTRIES = [];
  let START = null; // { datum, betrag } – Kassenbestand vor dem ersten Eintrag

  async function reload() {
    ENTRIES = (await allEntries()).map(K.normalize);
    START = await getSetting('anfangsbestand');
    render();
  }

  // ---------- Liste ----------
  function entryCard(e) {
    const b = el('button', 'entry ' + e.typ);
    b.type = 'button';
    let who, sub = '', amt;
    if (e.typ === 'zbon') {
      who = 'Kassenabrechnung';
      const parts = [];
      if (e.u19) parts.push('19 %: ' + P.formatCents(e.u19));
      if (e.u7) parts.push('7 %: ' + P.formatCents(e.u7));
      if (e.u0) parts.push('Gutsch.: ' + P.formatCents(e.u0));
      if (e.ec) parts.push('EC: −' + P.formatCents(e.ec));
      if (e.gutschein) parts.push('eingel.: −' + P.formatCents(e.gutschein));
      if (e.aus) parts.push('Ausz.: −' + P.formatCents(e.aus));
      if (e.ein) parts.push('Einz.: ' + P.formatCents(e.ein));
      if (e.abl) parts.push('Abl.: −' + P.formatCents(e.abl));
      sub = parts.join(' · ');
      amt = '+' + eur(K.net(e));
    } else if (e.typ === 'einnahme') {
      who = e.text || 'Einnahme'; sub = 'Einnahme'; amt = '+' + eur(e.betrag);
    } else {
      who = e.text || 'Ausgabe'; sub = 'Ausgabe'; amt = '−' + eur(e.betrag);
    }
    b.append(el('span', 'who', who), el('span', 'amt', amt), el('span', 'when', sub));
    b.addEventListener('click', () => openEditor(e, { mode: 'edit' }));
    return b;
  }

  function render() {
    const rows = K.withBalance(ENTRIES, START);
    const end = rows.length ? rows[rows.length - 1].bestand : (START ? START.betrag : 0);
    const best = $('bestand');
    best.textContent = START ? eur(end) : 'festlegen';
    best.classList.toggle('neg', !!START && end < 0);

    const negDay = rows.find((r) => r.bestand < 0);
    const warn = $('warn');
    if (!START) { warn.hidden = false; warn.textContent = 'Bitte zuerst oben den Kassenbestand zu Beginn eintragen.'; }
    else if (negDay) { warn.hidden = false; warn.textContent = '⚠ Kassenbestand wird am ' + deDate(negDay.e.datum) + ' negativ. Bitte Einträge prüfen.'; }
    else warn.hidden = true;

    const list = $('list');
    list.innerHTML = '';
    if (!rows.length) {
      const empty = el('div', 'empty');
      empty.append(el('b', '', 'Noch keine Einträge'), document.createTextNode('Abends die Kassenabrechnung fotografieren. Ausgaben ohne Bon unter „Von Hand“.'));
      list.appendChild(empty);
    }

    // Tage, neueste zuerst
    const days = [];
    for (const r of rows) {
      const k = r.e.datum || '';
      if (!days.length || days[days.length - 1].key !== k) days.push({ key: k, items: [], bestand: 0 });
      const d = days[days.length - 1];
      d.items.push(r.e); d.bestand = r.bestand;
    }
    days.reverse();
    for (const d of days) {
      const head = el('div', 'group' + (d.bestand < 0 ? ' neg' : ''));
      head.append(el('span', '', dayLabel(d.key)), el('span', '', 'Bestand ' + eur(d.bestand)));
      list.appendChild(head);
      for (const e of d.items) list.appendChild(entryCard(e));
    }
    if (START) {
      const head = el('div', 'group');
      head.append(el('span', '', dayLabel(START.datum)), el('span', '', ''));
      const b = el('button', 'entry start');
      b.type = 'button';
      b.append(el('span', 'who', 'Kassenbestand zu Beginn'), el('span', 'amt', eur(START.betrag)), el('span', 'when', 'Anfangsbestand'));
      b.addEventListener('click', openStart);
      list.append(head, b);
    }
    list.appendChild(el('div', 'version', 'App-Version ' + APP_VERSION));
  }

  // ---------- Formulare ----------
  // Feld-Definitionen je Eintragsart
  const FORMS = {
    zbon: {
      title: { scan: 'Kassenabrechnung prüfen', manual: 'Kassenabrechnung eintragen', edit: 'Kassenabrechnung bearbeiten' },
      fields: [{ key: 'datum', label: 'Datum', type: 'date' }].concat(K.ZBON.map((f) => ({
        key: f.key, label: f.label + (f.sign < 0 ? ' (wird abgezogen)' : ''), type: 'money'
      })))
    },
    ausgabe: {
      title: { scan: 'Ausgabe prüfen', manual: 'Ausgabe eintragen', edit: 'Ausgabe bearbeiten' },
      fields: [
        { key: 'datum', label: 'Datum', type: 'date' },
        { key: 'text', label: 'Wofür / bei wem', type: 'text', placeholder: 'z. B. Metro, Bankeinzahlung' },
        { key: 'betrag', label: 'Betrag', type: 'money', required: true }
      ]
    },
    einnahme: {
      title: { manual: 'Sonstige Einnahme', edit: 'Einnahme bearbeiten' },
      fields: [
        { key: 'datum', label: 'Datum', type: 'date' },
        { key: 'text', label: 'Wofür', type: 'text', placeholder: 'z. B. Privateinlage, Wechselgeld' },
        { key: 'betrag', label: 'Betrag', type: 'money', required: true }
      ]
    },
    start: {
      title: { edit: 'Kassenbestand zu Beginn' },
      fields: [
        { key: 'datum', label: 'Stand vom', type: 'date' },
        { key: 'betrag', label: 'Bargeld in der Kasse', type: 'money', allowZero: true }
      ]
    }
  };

  let editing = null; // { entry, opts }

  function openEditor(entry, opts) {
    opts = opts || {};
    const form = FORMS[entry.typ];
    editing = { entry: Object.assign({}, entry), opts: opts };
    $('editorTitle').textContent = form.title[opts.mode] || form.title.edit;
    $('deleteBtn').hidden = opts.mode !== 'edit' || entry.typ === 'start';

    const flagged = opts.flagged || {};
    let hint = '';
    if (entry.typ === 'start') hint = 'Wie viel Bargeld lag in der Kasse, bevor der erste Eintrag kam? Am besten nachzählen.';
    else if (entry.typ === 'zbon') hint = opts.mode === 'scan' ? 'Werte mit dem Bon vergleichen. Leere Felder zählen als 0.' : 'Leere Felder zählen als 0. Beträge brutto, wie auf dem Bon.';
    else if (opts.mode === 'scan') hint = Object.keys(flagged).length ? 'Orange markierte Felder bitte prüfen.' : 'Stimmt alles? Dann speichern.';
    $('editorHint').textContent = hint;

    const box = $('fields');
    box.innerHTML = '';
    for (const f of form.fields) {
      const wrap = el('div', 'field' + (flagged[f.key] ? ' missing' : ''));
      const id = 'f_' + f.key;
      const label = el('label', '', f.label + (f.type === 'money' ? ' (€)' : ''));
      label.htmlFor = id;
      const input = document.createElement('input');
      input.id = id; input.name = f.key;
      const v = entry[f.key];
      if (f.type === 'date') { input.type = 'date'; input.value = v || ''; }
      else if (f.type === 'money') {
        input.type = 'text'; input.inputMode = 'decimal'; input.className = 'money'; input.autocomplete = 'off';
        input.placeholder = '0,00'; input.value = v ? P.formatCents(v) : (v === 0 && f.allowZero ? '0,00' : '');
      } else { input.type = 'text'; input.autocapitalize = 'words'; input.value = v || ''; input.placeholder = f.placeholder || ''; }
      input.addEventListener('input', () => { wrap.classList.remove('missing'); const n = wrap.querySelector('.note'); if (n) n.remove(); updateCalc(); });
      wrap.append(label, input);
      if (flagged[f.key]) wrap.appendChild(el('div', 'note', flagged[f.key]));
      box.appendChild(wrap);
    }
    updateCalc();
    // Erkannten Text zeigen (zum Prüfen oder zum Weiterschicken an den Entwickler)
    const raw = $('rawBox');
    raw.hidden = true;
    $('rawBtn').hidden = !(opts.mode === 'scan' && opts.ocrText);
    $('rawText').value = opts.ocrText || '';
    const diag = $('rawDiag');
    diag.innerHTML = '';
    if (opts.trace) {
      diag.appendChild(el('b', '', 'So wurde der Text gelesen:'));
      if (!opts.trace.length) diag.appendChild(el('div', 'diag-row', 'Keine passenden Zeilen gefunden.'));
      for (const t of opts.trace) {
        const r = el('div', 'diag-row');
        r.append(el('span', 'diag-role', t.rolle), el('code', '', t.zeile));
        diag.appendChild(r);
      }
    }
    $('editor').hidden = false;
  }

  // Live-Rechnung bei der Kassenabrechnung
  function updateCalc() {
    const calc = $('calc');
    if (!editing || editing.entry.typ !== 'zbon') { calc.hidden = true; return; }
    const z = {};
    for (const f of K.ZBON) z[f.key] = readMoney($('f_' + f.key).value) || 0;
    const bar = P.zbonBar(z);
    const total = bar - (z.aus || 0) + (z.ein || 0) - (z.abl || 0);
    calc.hidden = false;
    calc.innerHTML = '';
    const line = el('div', 'calc-main');
    line.append(el('span', '', 'Bar aus Verkäufen'), el('strong', bar < 0 ? 'neg' : '', eur(bar)));
    calc.append(line, el('div', 'calc-formula', '19 % + 7 % + Gutscheinverkauf − EC − eingelöste Gutscheine'));
    if (z.aus || z.ein || z.abl) {
      const l2 = el('div', 'calc-main');
      l2.append(el('span', '', 'Kasse gesamt'), el('strong', total < 0 ? 'neg' : '', (total >= 0 ? '+' : '') + eur(total)));
      calc.append(l2, el('div', 'calc-formula', 'Bar aus Verkäufen − Ausgaben + Einnahmen − Ablieferung'));
    }
    const lb = editing.opts.barLautBon;
    if (lb) {
      const same = lb === bar;
      calc.appendChild(el('div', 'calc-check ' + (same ? 'ok' : 'bad'),
        same ? '✓ Passt zu „Bar“ auf dem Bon' : '⚠ Auf dem Bon steht Bar ' + eur(lb) + ' – bitte Werte prüfen'));
    }
  }

  function closeEditor() { $('editor').hidden = true; editing = null; }

  function mark(input, msg) {
    const wrap = input.parentElement;
    wrap.classList.add('missing');
    let n = wrap.querySelector('.note');
    if (!n) { n = el('div', 'note'); wrap.appendChild(n); }
    n.textContent = msg;
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    const typ = editing.entry.typ;
    const out = Object.assign({}, editing.entry);
    let ok = true;
    for (const f of FORMS[typ].fields) {
      const input = $('f_' + f.key);
      let v = input.value.trim();
      if (f.type === 'money') {
        const c = readMoney(v);
        if (v && (c === null || c < 0)) { mark(input, 'Bitte als Betrag eingeben, z. B. 12,50'); ok = false; continue; }
        if (f.required && !c) { mark(input, 'Bitte Betrag eintragen'); ok = false; continue; }
        if (f.allowZero && c === null) { mark(input, 'Bitte eintragen (auch 0 ist möglich)'); ok = false; continue; }
        v = c;
      }
      if (f.type === 'date' && !v) { mark(input, 'Bitte Datum wählen'); ok = false; continue; }
      out[f.key] = v === '' ? null : v;
    }
    if (ok && typ === 'zbon' && !K.ZBON.some((f) => out[f.key])) { mark($('f_u19'), 'Bitte mindestens einen Betrag eintragen'); ok = false; }
    if (!ok) return;

    if (typ === 'start') {
      await setSetting('anfangsbestand', { datum: out.datum, betrag: out.betrag || 0 });
    } else {
      delete out.haendler;
      if (!out.erstellt) out.erstellt = new Date().toISOString();
      await saveEntry(out);
    }
    closeEditor();
    await reload();
    toast('Gespeichert');
  }

  function openStart() {
    openEditor({ typ: 'start', datum: START ? START.datum : todayIso(), betrag: START ? START.betrag : null }, { mode: 'edit' });
  }

  // ---------- Auswahl-Blatt ----------
  function choose(title, hint, options) {
    $('choiceTitle').textContent = title;
    $('choiceHint').textContent = hint || '';
    $('choiceHint').hidden = !hint;
    const list = $('choiceList');
    list.innerHTML = '';
    for (const o of options) {
      const b = el('button', 'choice');
      b.type = 'button';
      b.append(el('b', '', o.label));
      if (o.sub) b.append(el('small', '', o.sub));
      b.addEventListener('click', () => { $('choice').hidden = true; o.run(); });
      list.appendChild(b);
    }
    $('choice').hidden = false;
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

  function scanQr(canvas) {
    if (!window.jsQR) return null;
    try {
      const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(d.data, d.width, d.height, { inversionAttempts: 'dontInvert' });
      return code ? P.parseTseQr(code.data) : null;
    } catch (e) { return null; }
  }

  async function processFile(file, typ) {
    if (!file) return;
    const img = await loadImg(file);
    $('busyImg').src = img.src;
    $('busyText').textContent = typ === 'zbon' ? 'Kassenabrechnung wird gelesen …' : 'Beleg wird gelesen …';
    setBar('busyBar', 0.03);
    $('busy').hidden = false;

    let text = '', qr = null, failed = false;
    try {
      onProgress = (p) => setBar('busyBar', 0.1 + p * 0.9);
      await loadVendor();
      if (typ === 'ausgabe') qr = scanQr(drawScaled(img, 2000));
      setBar('busyBar', 0.08);
      const worker = await getWorker();
      const { data } = await worker.recognize(window.BonBild.prepare(img));
      text = data.text || '';
    } catch (e) {
      console.error(e);
      failed = true;
      toast('Automatisches Lesen hat nicht geklappt – bitte Werte von Hand eintragen.', 4000);
    } finally {
      $('busy').hidden = true;
      URL.revokeObjectURL(img.src);
    }

    const flagged = {};
    let entry, extra = {};
    if (typ === 'zbon') {
      const z = P.parseZBon(text);
      extra.trace = z.trace;
      entry = { typ: 'zbon', datum: z.datum, u19: z.u19, u7: z.u7, u0: z.u0, ec: z.ec, gutschein: z.gutschein, aus: z.aus, ein: z.ein, abl: z.abl };
      extra.barLautBon = z.barLautBon;
      if (!failed && !z.u19 && !z.u7 && !z.u0) flagged.u19 = 'Umsätze nicht erkannt – bitte vom Bon abtippen';
      if (z.korrigiert && z.korrigiert !== 'barLautBon') flagged[z.korrigiert] = 'Lesefehler 0/8 automatisch korrigiert – bitte mit dem Bon vergleichen';
    } else {
      const r = P.combine(P.parseOcrText(text), qr);
      entry = { typ: 'ausgabe', datum: r.datum, text: r.haendler, betrag: r.betrag };
      if (!failed && !r.betrag) flagged.betrag = 'Nicht erkannt';
      if (!failed && !r.haendler) flagged.text = 'Nicht erkannt';
    }
    if (!entry.datum) { entry.datum = todayIso(); if (!failed) flagged.datum = 'Nicht erkannt – heute eingesetzt, bitte prüfen'; }
    openEditor(entry, Object.assign({ mode: 'scan', flagged: flagged, ocrText: text }, extra));
  }

  // ---------- Excel ----------
  function exportMenu() {
    if (!ENTRIES.length) { toast('Noch keine Einträge zum Exportieren'); return; }
    if (!START) { toast('Bitte zuerst den Kassenbestand zu Beginn eintragen'); openStart(); return; }
    const opts = K.months(ENTRIES).map((m) => ({ label: K.monthLabel(m), run: () => exportExcel(m) }));
    opts.push({ label: 'Alle Einträge', sub: 'Vom Anfangsbestand bis heute', run: () => exportExcel(null) });
    choose('Excel erstellen', 'Für welchen Zeitraum?', opts);
  }

  async function exportExcel(month) {
    const out = K.buildSheet(ENTRIES, START, month);
    const blob = window.XlsxLite.build(out.sheet);
    const name = (month ? 'Kassenbuch_' + month : 'Kassenbuch_gesamt_' + todayIso()) + '.xlsx';
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: out.title }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    // Download (Android: Chrome teilt keine .xlsx-Dateien). Die Daten bleiben lange verfügbar,
    // weil Chrome erst nach der Rückfrage „Datei herunterladen?“ wirklich liest.
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10 * 60 * 1000);
    toast(out.title + ' erstellt – siehe Downloads', 4000);
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

  function needStart(fn) {
    return (ev) => {
      if (START) return fn(ev);
      if (ev && ev.preventDefault) ev.preventDefault();
      toast('Bitte zuerst den Kassenbestand zu Beginn eintragen');
      openStart();
    };
  }

  function wire() {
    const pick = (typ) => (ev) => { const f = ev.target.files[0]; ev.target.value = ''; processFile(f, typ); };
    $('camZbon').addEventListener('change', pick('zbon'));
    $('galleryInput').addEventListener('change', pick('zbon'));
    // Ohne Anfangsbestand erst diesen abfragen
    document.querySelector('label[for=camZbon]').addEventListener('click', needStart(() => {}));
    $('galleryBtn').addEventListener('click', needStart(() => $('galleryInput').click()));
    $('manualBtn').addEventListener('click', needStart(() => choose('Von Hand eintragen', '', [
      { label: 'Kassenabrechnung', sub: 'Umsätze, EC, Gutscheine vom Bon abtippen', run: () => openEditor({ typ: 'zbon', datum: todayIso() }, { mode: 'manual' }) },
      { label: 'Ausgabe', sub: 'Einkauf, Bankeinzahlung, Entnahme ohne Bon …', run: () => openEditor({ typ: 'ausgabe', datum: todayIso() }, { mode: 'manual' }) },
      { label: 'Sonstige Einnahme', sub: 'Privateinlage, Wechselgeld von der Bank …', run: () => openEditor({ typ: 'einnahme', datum: todayIso() }, { mode: 'manual' }) }
    ])));
    $('exportBtn').addEventListener('click', exportMenu);
    $('rawBtn').addEventListener('click', () => { $('rawBox').hidden = !$('rawBox').hidden; });
    $('rawCopy').addEventListener('click', async () => {
      const t = $('rawText').value;
      try { await navigator.clipboard.writeText(t); toast('Text kopiert'); }
      catch (e) { $('rawText').select(); toast('Text markiert – jetzt kopieren'); }
    });
    $('bestandBtn').addEventListener('click', openStart);
    $('choiceCancel').addEventListener('click', () => { $('choice').hidden = true; });
    $('form').addEventListener('submit', onSubmit);
    $('cancelBtn').addEventListener('click', closeEditor);
    $('deleteBtn').addEventListener('click', async () => {
      if (!editing || !editing.entry.id) return;
      if (!confirm('Diesen Eintrag wirklich löschen?')) return;
      await deleteEntry(editing.entry.id);
      closeEditor(); await reload(); toast('Gelöscht');
    });
  }

  async function start() {
    wire();
    await reload();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    try { await setupOffline(); } catch (e) { console.error(e); }
    if (!START) openStart();
    // Texterkennung im Hintergrund vorwärmen, damit der erste Scan schneller geht
    setTimeout(() => getWorker().catch(() => {}), 1500);
  }

  start();
})();
