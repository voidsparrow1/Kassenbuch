/* Kassenbuch – Kassenabrechnung fotografieren, Kassenbestand führen, Kassenbuch als PDF.
   GoBD-orientiert: fortlaufende Belegnummern, keine Änderung/Löschung (nur Storno mit Grund),
   Prüfsummen-Kette (SHA-256), Festschreibung je Monat, Belegfotos, Kassensturz. */
(function () {
  'use strict';
  const P = window.BonParser;
  const K = window.Kassenbuch;
  const $ = (id) => document.getElementById(id);

  const APP_VERSION = 13;   // sichtbar unten in der Liste – zum Prüfen, ob ein Update angekommen ist
  const LATE_DAYS = 10;     // ab so vielen Tagen Abstand gilt eine Buchung als nachträglich erfasst
  const USE_SW = 'serviceWorker' in navigator && !/[?&]nosw\b/.test(location.search);
  const abs = (p) => new URL(p, location.href).href;

  // ---------- Speicher (IndexedDB, bleibt auf dem Gerät) ----------
  let dbP = null;
  function db() {
    if (!dbP) dbP = new Promise((res, rej) => {
      const r = indexedDB.open('kassenbuch', 3);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('eintraege')) d.createObjectStore('eintraege', { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains('einstellungen')) d.createObjectStore('einstellungen', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('belege')) d.createObjectStore('belege', { keyPath: 'nr' });
        if (!d.objectStoreNames.contains('protokoll')) d.createObjectStore('protokoll', { keyPath: 'id', autoIncrement: true });
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
  const putEntry = (e) => tx('eintraege', 'readwrite', (s) => s.put(e));
  const getSetting = async (key) => { const r = await tx('einstellungen', 'readonly', (s) => s.get(key)); return r ? r.value : null; };
  const setSetting = (key, value) => tx('einstellungen', 'readwrite', (s) => s.put({ key: key, value: value }));
  const getBeleg = (nr) => tx('belege', 'readonly', (s) => s.get(nr));
  const putBeleg = (b) => tx('belege', 'readwrite', (s) => s.put(b));
  const allProtokoll = () => tx('protokoll', 'readonly', (s) => s.getAll());
  const log = (text, monat) => tx('protokoll', 'readwrite', (s) => s.add({ am: new Date().toISOString(), text: text, monat: monat || null }));

  // ---------- Prüfsummen ----------
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  const sha = async (str) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)));
  const shaBytes = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));

  // ---------- Hilfen ----------
  const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const eur = (c) => P.formatCents(c || 0) + ' €';
  const deDate = (iso) => iso ? iso.split('-').reverse().join('.') : '';
  const deStamp = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }); };
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
  let START = null;   // { datum, betrag, firma } – Kassenbestand vor der ersten Buchung
  let CLOSED = {};    // { '2026-08': { am, hash, bisNr } } – festgeschriebene Monate
  let CHAIN = { ok: true, count: 0 };

  async function reload() {
    ENTRIES = (await allEntries()).map(K.normalize);
    START = await getSetting('anfangsbestand');
    CLOSED = (await getSetting('festgeschrieben')) || {};
    await migrate();
    CHAIN = await K.verifyChain(ENTRIES, sha);
    render();
  }

  // Einträge aus App-Versionen vor der Prüfsummen-Kette: einmalig nummerieren und versiegeln
  async function migrate() {
    const old = ENTRIES.filter((e) => !e.nr).sort((a, b) => a.id - b.id);
    if (!old.length) return;
    for (const e of old) {
      e.nr = K.nextNr(ENTRIES);
      e.erfasst = e.erstellt || new Date().toISOString();
      delete e.erstellt; delete e.haendler;
      await K.seal(e, K.lastHash(ENTRIES.filter((x) => x.nr && x !== e)), sha);
      await putEntry(e);
    }
    await log(old.length + ' Einträge aus einer früheren App-Version übernommen und nummeriert (Beleg ' +
      K.belegNr(old[0]) + '–' + K.belegNr(old[old.length - 1]) + ')');
  }

  // Neue Buchung: fortlaufende Nummer, Erfassungszeit, Foto-Prüfsumme, Verkettung – danach unveränderlich
  async function book(entry, photo) {
    const e = Object.assign({}, entry);
    delete e.id;
    e.nr = K.nextNr(ENTRIES);
    e.erfasst = new Date().toISOString();
    if (photo) {
      const bytes = new Uint8Array(await photo.blob.arrayBuffer());
      e.fotoHash = await shaBytes(bytes);
      await putBeleg({ nr: e.nr, blob: photo.blob, w: photo.w, h: photo.h, hash: e.fotoHash });
    }
    await K.seal(e, K.lastHash(ENTRIES), sha);
    await putEntry(e);
    ENTRIES.push(e);
    return e;
  }

  // ---------- Liste ----------
  function entryCard(e, storniert) {
    const b = el('button', 'entry ' + e.typ + (storniert ? ' storniert' : ''));
    b.type = 'button';
    let who, sub = '', amt;
    const nr = 'Beleg ' + K.belegNr(e);
    if (e.typ === 'zbon') {
      who = 'Kassenabrechnung';
      const parts = [nr];
      if (e.u19) parts.push('19 %: ' + P.formatCents(e.u19));
      if (e.u7) parts.push('7 %: ' + P.formatCents(e.u7));
      if (e.u0) parts.push('0 %: ' + P.formatCents(e.u0));
      if (e.ec) parts.push('EC: −' + P.formatCents(e.ec));
      if (e.gutschein) parts.push('Gutsch.: −' + P.formatCents(e.gutschein));
      sub = parts.join(' · ');
      amt = (K.net(e) >= 0 ? '+' : '') + eur(K.net(e));
    } else if (e.typ === 'einnahme') {
      who = e.text || 'Einnahme'; sub = nr + ' · Einnahme'; amt = '+' + eur(e.betrag);
    } else if (e.typ === 'storno') {
      who = 'Storno zu Beleg ' + String(e.ref).padStart(4, '0'); sub = nr + ' · ' + (e.grund || ''); amt = (K.net(e) >= 0 ? '+' : '') + eur(K.net(e));
    } else if (e.typ === 'zaehlung') {
      const d = (e.ist || 0) - (e.soll || 0);
      who = 'Kassensturz'; sub = nr + (d ? ' · Differenz ' + eur(d) : ' · stimmt'); amt = eur(e.ist);
    } else {
      who = e.text || 'Ausgabe'; sub = nr + ' · Ausgabe'; amt = '−' + eur(e.betrag);
    }
    if (storniert) sub = 'storniert durch Beleg ' + K.belegNr(storniert) + ' · ' + sub;
    if (e.fotoHash) sub += ' · 📷';
    b.append(el('span', 'who', who), el('span', 'amt', amt), el('span', 'when', sub));
    b.addEventListener('click', () => openDetail(e));
    return b;
  }

  function render() {
    const rows = K.withBalance(ENTRIES, START);
    const sm = K.stornoMap(ENTRIES);
    const end = rows.length ? rows[rows.length - 1].bestand : (START ? START.betrag : 0);
    const best = $('bestand');
    best.textContent = START ? eur(end) : 'festlegen';
    best.classList.toggle('neg', !!START && end < 0);

    const negDay = K.dayBalances(ENTRIES, START).find((d) => d.bestand < 0);
    const warn = $('warn');
    warn.className = 'warn';
    const today = todayIso();
    const openPast = K.closableMonths(ENTRIES, START, CLOSED, today).filter((m) => ENTRIES.some((e) => (e.datum || '').startsWith(m)));
    if (!CHAIN.ok) {
      warn.hidden = false; warn.className = 'warn bad';
      warn.textContent = '⚠ Prüfsumme stimmt nicht (Beleg ' + String(CHAIN.at || 0).padStart(4, '0') + ', ' + CHAIN.grund + '). Daten wurden außerhalb der App verändert.';
    } else if (!START) { warn.hidden = false; warn.textContent = 'Bitte zuerst oben den Kassenbestand zu Beginn eintragen.'; }
    else if (negDay) { warn.hidden = false; warn.textContent = '⚠ Kassenbestand ist am ' + deDate(negDay.datum) + ' negativ. Bitte Buchungen prüfen und ggf. stornieren.'; }
    else if (openPast.length && +today.slice(8, 10) >= 5) {
      warn.hidden = false;
      warn.textContent = K.monthLabel(openPast[openPast.length - 1]) + ' ist noch nicht abgeschlossen. Unter „Kassenbuch“ den Monat festschreiben.';
    } else warn.hidden = true;

    const list = $('list');
    list.innerHTML = '';
    if (!rows.length) {
      const empty = el('div', 'empty');
      empty.append(el('b', '', 'Noch keine Buchungen'), document.createTextNode('Abends die Kassenabrechnung fotografieren. Ausgaben ohne Bon unter „Von Hand“.'));
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
      const locked = CLOSED[d.key.slice(0, 7)] || (K.closedUntil(CLOSED) && d.key.slice(0, 7) <= K.closedUntil(CLOSED));
      const head = el('div', 'group' + (d.bestand < 0 ? ' neg' : ''));
      head.append(el('span', '', dayLabel(d.key) + (locked ? ' 🔒' : '')), el('span', '', 'Bestand ' + eur(d.bestand)));
      list.appendChild(head);
      for (const e of d.items) list.appendChild(entryCard(e, sm[e.nr]));
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
    const foot = el('div', 'version', 'App-Version ' + APP_VERSION + ' · ' + (CHAIN.ok ? '✓ Prüfsummen in Ordnung (' + CHAIN.count + ' Buchungen)' : '⚠ Prüfsummen fehlerhaft'));
    list.appendChild(foot);
  }

  // ---------- Formulare ----------
  const FORMS = {
    zbon: {
      title: { scan: 'Kassenabrechnung prüfen', manual: 'Kassenabrechnung eintragen' },
      fields: [{ key: 'datum', label: 'Datum', type: 'date' }].concat(K.ZBON.map((f) => ({
        key: f.key, label: f.label + (f.sign < 0 ? ' (wird abgezogen)' : ''), type: 'money'
      })))
    },
    ausgabe: {
      title: { scan: 'Ausgabe prüfen', manual: 'Ausgabe eintragen' },
      fields: [
        { key: 'datum', label: 'Datum', type: 'date' },
        { key: 'text', label: 'Wofür / bei wem', type: 'text', placeholder: 'z. B. Metro, Bankeinzahlung', required: true },
        { key: 'betrag', label: 'Betrag', type: 'money', required: true }
      ]
    },
    einnahme: {
      title: { manual: 'Sonstige Einnahme' },
      fields: [
        { key: 'datum', label: 'Datum', type: 'date' },
        { key: 'text', label: 'Wofür', type: 'text', placeholder: 'z. B. Privateinlage, Wechselgeld', required: true },
        { key: 'betrag', label: 'Betrag', type: 'money', required: true }
      ]
    },
    zaehlung: {
      title: { manual: 'Kassensturz' },
      fields: [
        { key: 'datum', label: 'Datum', type: 'date' },
        { key: 'ist', label: 'Gezähltes Bargeld in der Kasse', type: 'money', allowZero: true }
      ]
    },
    storno: {
      title: { manual: 'Buchung stornieren' },
      fields: [{ key: 'grund', label: 'Grund für das Storno', type: 'text', placeholder: 'z. B. Betrag falsch erfasst', required: true }]
    },
    start: {
      title: { edit: 'Kassenbestand zu Beginn' },
      fields: [
        { key: 'datum', label: 'Stand vom', type: 'date', lock: true },
        { key: 'betrag', label: 'Bargeld in der Kasse', type: 'money', allowZero: true, lock: true },
        { key: 'firma', label: 'Name des Geschäfts (steht oben im Kassenbuch)', type: 'text', placeholder: 'optional' }
      ]
    }
  };

  let editing = null; // { entry, opts }

  function openEditor(entry, opts) {
    opts = opts || {};
    const form = FORMS[entry.typ];
    editing = { entry: Object.assign({}, entry), opts: opts };
    $('editorTitle').textContent = opts.title || form.title[opts.mode] || form.title.manual || form.title.edit;

    const flagged = opts.flagged || {};
    const locked = entry.typ === 'start' && ENTRIES.length > 0;
    let hint = '';
    if (entry.typ === 'start') hint = locked ? 'Der Anfangsbestand ist festgelegt, weil schon gebucht wurde. Nur der Name lässt sich noch ändern.'
      : 'Wie viel Bargeld lag in der Kasse, bevor die erste Buchung kam? Am besten nachzählen. Kann nach der ersten Buchung nicht mehr geändert werden.';
    else if (entry.typ === 'zbon') hint = opts.mode === 'scan' ? 'Werte mit dem Bon vergleichen. Leere Felder zählen als 0. Nach dem Speichern ist die Buchung unveränderlich.' : 'Leere Felder zählen als 0. Beträge brutto, wie auf dem Bon.';
    else if (entry.typ === 'zaehlung') hint = 'Das gesamte Bargeld in der Kasse zählen. Weicht es vom Kassenbestand laut Buchungen ab, wird die Differenz gebucht.';
    else if (entry.typ === 'storno') hint = 'Die Buchung bleibt im Kassenbuch sichtbar und wird durch eine Gegenbuchung aufgehoben.';
    else if (opts.mode === 'scan') hint = Object.keys(flagged).length ? 'Orange markierte Felder bitte prüfen.' : 'Stimmt alles? Dann speichern.';
    if (opts.korrekturVon) hint = 'Die alte Buchung wurde storniert. Hier die richtigen Werte eintragen.';
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
      if (f.type === 'date') { input.type = 'date'; input.value = v || ''; input.max = todayIso(); }
      else if (f.type === 'money') {
        input.type = 'text'; input.inputMode = 'decimal'; input.className = 'money'; input.autocomplete = 'off';
        input.placeholder = '0,00'; input.value = v ? P.formatCents(v) : (v === 0 && f.allowZero ? '0,00' : '');
      } else { input.type = 'text'; input.autocapitalize = 'sentences'; input.value = v || ''; input.placeholder = f.placeholder || ''; }
      if (locked && f.lock) input.disabled = true;
      input.addEventListener('input', () => { wrap.classList.remove('missing'); const n = wrap.querySelector('.note'); if (n) n.remove(); updateCalc(); });
      wrap.append(label, input);
      if (flagged[f.key]) wrap.appendChild(el('div', 'note', flagged[f.key]));
      box.appendChild(wrap);
    }
    updateCalc();
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

  // Live-Rechnung bei der Kassenabrechnung bzw. beim Kassensturz
  function updateCalc() {
    const calc = $('calc');
    if (!editing) { calc.hidden = true; return; }
    if (editing.entry.typ === 'zaehlung') {
      const datum = $('f_datum').value || todayIso();
      const soll = K.balanceAt(ENTRIES, START, datum);
      const ist = readMoney($('f_ist').value);
      calc.hidden = false; calc.innerHTML = '';
      const line = el('div', 'calc-main');
      line.append(el('span', '', 'Soll laut Kassenbuch'), el('strong', '', eur(soll)));
      calc.appendChild(line);
      if (ist !== null) {
        const d = ist - soll;
        calc.appendChild(el('div', 'calc-check ' + (d ? 'bad' : 'ok'), d ? 'Differenz ' + (d > 0 ? '+' : '') + eur(d) + ' – wird als Kassendifferenz gebucht' : '✓ Kasse stimmt'));
      }
      return;
    }
    if (editing.entry.typ !== 'zbon') { calc.hidden = true; return; }
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

  let saving = false;
  async function onSubmit(ev) {
    ev.preventDefault();
    if (saving) return;
    const typ = editing.entry.typ;
    const opts = editing.opts;
    const out = Object.assign({}, editing.entry);
    const locked = typ === 'start' && ENTRIES.length > 0;
    let ok = true;
    for (const f of FORMS[typ].fields) {
      const input = $('f_' + f.key);
      if (locked && f.lock) continue;
      let v = input.value.trim();
      if (f.type === 'money') {
        const c = readMoney(v);
        if (v && (c === null || c < 0)) { mark(input, 'Bitte als Betrag eingeben, z. B. 12,50'); ok = false; continue; }
        if (f.required && !c) { mark(input, 'Bitte Betrag eintragen'); ok = false; continue; }
        if (f.allowZero && c === null) { mark(input, 'Bitte eintragen (auch 0 ist möglich)'); ok = false; continue; }
        v = c;
      }
      if (f.type === 'text' && f.required && !v) { mark(input, 'Bitte ausfüllen'); ok = false; continue; }
      if (f.type === 'date') {
        const err = typ === 'start' ? (!v ? 'Bitte Datum wählen' : v > todayIso() ? 'Datum liegt in der Zukunft' : null)
          : K.checkDate(v, CLOSED, todayIso()) || (START && v < START.datum ? 'Liegt vor dem Anfangsbestand (' + deDate(START.datum) + ')' : null);
        if (err) { mark(input, err); ok = false; continue; }
      }
      out[f.key] = v === '' ? null : v;
    }
    if (ok && typ === 'zbon' && !K.ZBON.some((f) => out[f.key])) { mark($('f_u19'), 'Bitte mindestens einen Betrag eintragen'); ok = false; }
    if (!ok) return;

    saving = true;
    try {
      if (typ === 'start') return await saveStart(out, locked);
      if (typ === 'storno') return await saveStorno(opts.target, out.grund, opts.then);

      // Nachträgliche Erfassung und negativer Bestand: bewusst bestätigen lassen
      const late = K.daysBetween(out.datum, todayIso());
      if (late > LATE_DAYS) {
        if (!confirm('Diese Buchung liegt ' + late + ' Tage zurück. Kassenbücher sollen täglich geführt werden; die Buchung wird als „nachträglich erfasst“ gekennzeichnet. Trotzdem speichern?')) return;
        out.nachtraeglich = true;
      }
      if (typ === 'zaehlung') return await saveZaehlung(out);
      const neg = K.dayBalances(ENTRIES.concat([Object.assign({ nr: 1e9 }, out)]), START).find((d) => d.bestand < 0);
      if (neg && !confirm('Mit dieser Buchung wird der Kassenbestand am ' + deDate(neg.datum) + ' negativ (' + eur(neg.bestand) + '). Das deutet auf einen Fehler hin. Trotzdem speichern?')) return;

      if (opts.korrekturVon) out.korrektur_von = opts.korrekturVon;
      const e = await book(out, opts.photo);
      closeEditor();
      await reload();
      toast('Gebucht als Beleg ' + K.belegNr(e));
    } finally { saving = false; }
  }

  async function saveStart(out, locked) {
    const prev = START;
    const next = locked ? Object.assign({}, prev, { firma: out.firma || '' })
      : { datum: out.datum, betrag: out.betrag || 0, firma: out.firma || '' };
    await setSetting('anfangsbestand', next);
    if (!locked && (!prev || prev.betrag !== next.betrag || prev.datum !== next.datum)) {
      await log('Anfangsbestand festgelegt: ' + eur(next.betrag) + ' zum ' + deDate(next.datum));
    }
    closeEditor(); await reload(); toast('Gespeichert');
  }

  async function saveStorno(target, grund, then) {
    const s = K.makeStorno(target, grund, K.closedUntil(CLOSED), todayIso());
    const e = await book(s);
    closeEditor();
    await reload();
    toast('Beleg ' + K.belegNr(target) + ' storniert (Beleg ' + K.belegNr(e) + ')');
    if (then === 'fix') {
      const copy = {};
      for (const k of ['typ', 'datum', 'text', 'betrag'].concat(K.ZBON.map((f) => f.key))) if (target[k] !== undefined) copy[k] = target[k];
      if (K.checkDate(copy.datum, CLOSED, todayIso())) copy.datum = todayIso();
      openEditor(copy, { mode: 'manual', korrekturVon: target.nr, title: 'Korrektur zu Beleg ' + K.belegNr(target) });
    }
  }

  async function saveZaehlung(out) {
    out.soll = K.balanceAt(ENTRIES, START, out.datum);
    const z = await book(out);
    const d = out.ist - out.soll;
    let msg = 'Kassensturz gebucht (Beleg ' + K.belegNr(z) + ')';
    if (d) {
      const k = await book({ typ: d > 0 ? 'einnahme' : 'ausgabe', datum: out.datum, text: 'Kassendifferenz laut Kassensturz Beleg ' + K.belegNr(z), betrag: Math.abs(d) });
      msg += ', Differenz ' + eur(d) + ' als Beleg ' + K.belegNr(k);
    }
    closeEditor(); await reload(); toast(msg, 4000);
  }

  function openStart() {
    openEditor({ typ: 'start', datum: START ? START.datum : todayIso(), betrag: START ? START.betrag : null, firma: START ? START.firma : '' }, { mode: 'edit' });
  }

  // ---------- Detailansicht einer Buchung (nur lesen, Storno/Korrektur) ----------
  let detailUrl = null;
  async function openDetail(e) {
    const sm = K.stornoMap(ENTRIES);
    const st = sm[e.nr];
    $('detailTitle').textContent = (K.TYP_NAME[e.typ] || 'Buchung') + ' · Beleg ' + K.belegNr(e);
    const parts = ['Buchungsdatum ' + deDate(e.datum), 'erfasst ' + deStamp(e.erfasst)];
    if (e.nachtraeglich) parts.push('nachträglich erfasst');
    $('detailSub').textContent = parts.join(' · ');
    const body = $('detailBody');
    body.innerHTML = '';
    const row = (a, b, cls) => { const r = el('div', 'drow' + (cls ? ' ' + cls : '')); r.append(el('span', '', a), el('b', '', b)); body.appendChild(r); };
    if (st) row('Status', 'storniert durch Beleg ' + K.belegNr(st) + ': ' + (st.grund || ''), 'bad');
    if (e.typ === 'storno') row('Storniert', 'Beleg ' + String(e.ref).padStart(4, '0') + ' – Grund: ' + (e.grund || ''));
    if (e.korrektur_von) row('Korrektur zu', 'Beleg ' + String(e.korrektur_von).padStart(4, '0'));
    if (e.typ === 'zaehlung') { row('Gezählt', eur(e.ist)); row('Soll', eur(e.soll)); row('Differenz', eur(e.ist - e.soll)); }
    for (const l of K.lines(e)) {
      if (l.info) continue;
      const a = l.ein - l.aus;
      row(l.text.replace(/^Kassenabrechnung /, ''), (a > 0 ? '+' : '') + eur(a));
    }
    const locked = !!K.checkDate(e.datum, CLOSED, todayIso()) && e.datum <= todayIso();
    row('Prüfsumme', (e.hash || '').slice(0, 16) + '…', 'mono');

    const img = $('detailFoto');
    img.hidden = true;
    if (detailUrl) { URL.revokeObjectURL(detailUrl); detailUrl = null; }
    if (e.fotoHash) {
      const b = await getBeleg(e.nr);
      if (b) { detailUrl = URL.createObjectURL(b.blob); img.src = detailUrl; img.hidden = false; }
    }
    const canStorno = !st && e.typ !== 'storno';
    $('detailStorno').hidden = !canStorno;
    $('detailFix').hidden = !canStorno || e.typ === 'zaehlung';
    $('detailLock').hidden = !locked || !canStorno;
    $('detailStorno').onclick = () => { closeDetail(); openEditor({ typ: 'storno' }, { mode: 'manual', target: e, then: 'only', title: 'Beleg ' + K.belegNr(e) + ' stornieren' }); };
    $('detailFix').onclick = () => { closeDetail(); openEditor({ typ: 'storno' }, { mode: 'manual', target: e, then: 'fix', title: 'Beleg ' + K.belegNr(e) + ' korrigieren' }); };
    $('detail').hidden = false;
  }
  function closeDetail() { $('detail').hidden = true; }

  // ---------- Auswahl-Blatt ----------
  function choose(title, hint, options) {
    $('choiceTitle').textContent = title;
    $('choiceHint').textContent = hint || '';
    $('choiceHint').hidden = !hint;
    const list = $('choiceList');
    list.innerHTML = '';
    for (const o of options) {
      const b = el('button', 'choice' + (o.danger ? ' danger' : ''));
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

  // Belegfoto platzsparend als JPEG speichern (längste Seite 2000 px)
  function compressPhoto(img) {
    const c = drawScaled(img, 2000);
    return new Promise((res) => c.toBlob((blob) => res(blob ? { blob: blob, w: c.width, h: c.height } : null), 'image/jpeg', 0.62));
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

    let text = '', qr = null, failed = false, photo = null;
    try {
      photo = await compressPhoto(img);
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
    let entry, extra = { photo: photo };
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
    const derr = K.checkDate(entry.datum, CLOSED, todayIso());
    if (derr) flagged.datum = derr;
    openEditor(entry, Object.assign({ mode: 'scan', flagged: flagged, ocrText: text }, extra));
  }

  // ---------- Kassenbuch (PDF), Excel, Festschreibung ----------
  function exportMenu() {
    if (!START) { toast('Bitte zuerst den Kassenbestand zu Beginn eintragen'); openStart(); return; }
    const today = todayIso();
    const closable = K.closableMonths(ENTRIES, START, CLOSED, today);
    const months = K.months(ENTRIES);
    for (const m of closable) if (months.indexOf(m) < 0) months.push(m);
    months.sort().reverse();
    if (!months.length) { toast('Noch keine Buchungen'); return; }
    const pick = (m) => () => {
      const opts = [
        { label: 'Kassenbuch (PDF)', sub: 'Mit Belegverzeichnis und Prüfsumme', run: () => exportPdf(m, false) },
        { label: 'Kassenbuch mit Belegfotos (PDF)', sub: 'Zusätzlich jedes gespeicherte Bonfoto als eigene Seite', run: () => exportPdf(m, true) },
        { label: 'Excel-Tabelle', sub: 'Zum Weiterrechnen', run: () => exportExcel(m) }
      ];
      if (m && closable.indexOf(m) >= 0) opts.unshift({ label: 'Monat abschließen (festschreiben)', sub: 'Danach keine Buchungen mehr in diesem Monat möglich', run: () => closeMonth(m) });
      const st = m ? (isClosed(m) ? 'festgeschrieben 🔒' : 'noch offen') : '';
      choose(m ? 'Kassenbuch ' + K.monthLabel(m) : 'Kassenbuch gesamt', st, opts);
    };
    const opts = months.map((m) => ({ label: K.monthLabel(m) + (isClosed(m) ? ' 🔒' : ''), sub: isClosed(m) ? 'festgeschrieben' : (closable.indexOf(m) >= 0 ? 'kann abgeschlossen werden' : 'laufender Monat'), run: pick(m) }));
    opts.push({ label: 'Alle Buchungen', sub: 'Vom Anfangsbestand bis heute', run: pick(null) });
    choose('Kassenbuch', 'Für welchen Monat?', opts);
  }
  const isClosed = (m) => !!(CLOSED[m] || (K.closedUntil(CLOSED) && m <= K.closedUntil(CLOSED)));

  async function closeMonth(m) {
    if (!CHAIN.ok) { toast('Prüfsummen sind fehlerhaft – Abschluss nicht möglich'); return; }
    const earlier = K.closableMonths(ENTRIES, START, CLOSED, todayIso()).filter((x) => x <= m);
    const names = earlier.map(K.monthLabel).join(', ');
    if (!confirm('Abschließen: ' + names + '.\n\nDanach sind in diesen Monaten keine Buchungen und Stornos mehr möglich. Korrekturen werden dann im laufenden Monat gebucht. Fortfahren?')) return;
    const info = { am: new Date().toISOString(), hash: K.lastHash(ENTRIES), bisNr: K.nextNr(ENTRIES) - 1 };
    for (const x of earlier) CLOSED[x] = info;
    await setSetting('festgeschrieben', CLOSED);
    for (const x of earlier) await log(K.monthLabel(x) + ' festgeschrieben (bis Beleg ' + String(info.bisNr).padStart(4, '0') + ')', x);
    await reload();
    toast(names + ' festgeschrieben 🔒', 3500);
    choose('Kassenbuch ' + K.monthLabel(m), 'festgeschrieben 🔒', [
      { label: 'Kassenbuch (PDF)', sub: 'Jetzt mit Vermerk „festgeschrieben“', run: () => exportPdf(m, false) },
      { label: 'Kassenbuch mit Belegfotos (PDF)', run: () => exportPdf(m, true) }
    ]);
  }

  // Datei teilen; wo Teilen nicht geht (z. B. .xlsx in Chrome auf Android), herunterladen
  async function deliver(blob, name, title) {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: title }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    // Die Daten bleiben lange verfügbar, weil Chrome erst nach der Rückfrage „Datei herunterladen?“ wirklich liest.
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10 * 60 * 1000);
    toast(title + ' erstellt – siehe Downloads', 4000);
  }

  async function exportPdf(month, withPhotos) {
    toast('Kassenbuch wird erstellt …', 1500);
    const inMonth = (e) => !month || (e.datum || '').startsWith(month);
    const fotos = [];
    if (withPhotos) {
      for (const e of ENTRIES) {
        if (!e.fotoHash || !inMonth(e)) continue;
        const b = await getBeleg(e.nr);
        if (b) fotos.push({ nr: e.nr, jpeg: new Uint8Array(await b.blob.arrayBuffer()), w: b.w, h: b.h });
      }
    }
    const proto = (await allProtokoll()).filter((p) => !month || (p.monat ? p.monat === month : (p.am || '').slice(0, 7) === month));
    const out = window.KassenbuchPdf.build(ENTRIES, START, month, {
      firma: START.firma || '', closed: CLOSED, chain: CHAIN, protokoll: proto, fotos: fotos
    });
    const blob = new Blob([out.bytes], { type: 'application/pdf' });
    const name = (month ? 'Kassenbuch_' + month : 'Kassenbuch_gesamt_' + todayIso()) + (withPhotos ? '_mit_Belegen' : '') + '.pdf';
    await deliver(blob, name, 'Kassenbuch ' + (month ? K.monthLabel(month) : 'gesamt'));
  }

  async function exportExcel(month) {
    const out = K.buildSheet(ENTRIES, START, month);
    const blob = window.XlsxLite.build(out.sheet);
    const name = (month ? 'Kassenbuch_' + month : 'Kassenbuch_gesamt_' + todayIso()) + '.xlsx';
    await deliver(blob, name, out.title);
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
    document.querySelector('label[for=camZbon]').addEventListener('click', needStart(() => {}));
    $('galleryBtn').addEventListener('click', needStart(() => $('galleryInput').click()));
    $('manualBtn').addEventListener('click', needStart(() => choose('Von Hand eintragen', '', [
      { label: 'Kassenabrechnung', sub: 'Umsätze, EC, Gutscheine vom Bon abtippen', run: () => openEditor({ typ: 'zbon', datum: todayIso() }, { mode: 'manual' }) },
      { label: 'Ausgabe', sub: 'Einkauf, Bankeinzahlung, Entnahme ohne Bon …', run: () => openEditor({ typ: 'ausgabe', datum: todayIso() }, { mode: 'manual' }) },
      { label: 'Sonstige Einnahme', sub: 'Privateinlage, Wechselgeld von der Bank …', run: () => openEditor({ typ: 'einnahme', datum: todayIso() }, { mode: 'manual' }) },
      { label: 'Kassensturz', sub: 'Bargeld zählen und mit dem Kassenbuch abgleichen', run: () => openEditor({ typ: 'zaehlung', datum: todayIso() }, { mode: 'manual' }) }
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
    $('detailClose').addEventListener('click', closeDetail);
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
