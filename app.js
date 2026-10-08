/* Kassenbuch – Kassenabrechnung fotografieren, Kassenbestand führen, Kassenbuch als PDF.
   GoBD-orientiert: fortlaufende Belegnummern, keine Änderung/Löschung (nur Storno mit Grund),
   Prüfsummen-Kette (SHA-256), Festschreibung je Monat, Belegfotos, Kassensturz. */
(function () {
  'use strict';
  const P = window.BonParser;
  const K = window.Kassenbuch;
  const $ = (id) => document.getElementById(id);

  const APP_VERSION = 15;   // sichtbar unten in der Liste – zum Prüfen, ob ein Update angekommen ist
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
  let LAST_BACKUP;    // Zeitpunkt der letzten Datensicherung

  async function reload() {
    ENTRIES = (await allEntries()).map(K.normalize);
    START = await getSetting('anfangsbestand');
    CLOSED = (await getSetting('festgeschrieben')) || {};
    LAST_BACKUP = (await getSetting('letzteSicherung')) || null;
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
    e.hv = K.HASH_VERSION;
    if (START && START.kassierer) e.kassierer = START.kassierer;
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
      who = 'Kassenabrechnung' + (e.znr ? ' #' + e.znr : '');
      const parts = [nr];
      if (e.u19) parts.push('19 %: ' + P.formatCents(e.u19));
      if (e.u7) parts.push('7 %: ' + P.formatCents(e.u7));
      if (e.u0) parts.push('0 %: ' + P.formatCents(e.u0));
      if (e.ec) parts.push('EC: −' + P.formatCents(e.ec));
      if (e.gutschein) parts.push('Gutsch.: −' + P.formatCents(e.gutschein));
      sub = parts.join(' · ');
      amt = (K.net(e) >= 0 ? '+' : '') + eur(K.net(e));
    } else if (e.typ === 'einnahme') {
      const a = K.artInfo('einnahme', e.art);
      who = e.text || 'Einnahme'; sub = nr + ' · ' + (a ? a.label : 'Einnahme'); amt = '+' + eur(e.betrag);
    } else if (e.typ === 'storno') {
      who = 'Storno zu Beleg ' + String(e.ref).padStart(4, '0'); sub = nr + ' · ' + (e.grund || ''); amt = (K.net(e) >= 0 ? '+' : '') + eur(K.net(e));
    } else if (e.typ === 'zaehlung') {
      const d = (e.ist || 0) - (e.soll || 0);
      who = 'Kassensturz'; sub = nr + (d ? ' · Differenz ' + eur(d) : ' · stimmt'); amt = eur(e.ist);
    } else {
      const a = K.artInfo('ausgabe', e.art);
      who = e.text || 'Ausgabe'; sub = nr + ' · ' + (a ? a.label : 'Ausgabe') + (e.eigenbeleg ? ' · Eigenbeleg' : ''); amt = '−' + eur(e.betrag);
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
      warn.textContent = '⚠ Die Daten wurden außerhalb der App verändert (ab Beleg ' + String(CHAIN.at || 0).padStart(4, '0') + '). Bitte den Steuerberater informieren.';
    } else if (!START) { warn.hidden = false; warn.textContent = 'Bitte zuerst oben den Kassenbestand zu Beginn eintragen.'; }
    else if (negDay) { warn.hidden = false; warn.textContent = '⚠ Kassenbestand ist am ' + deDate(negDay.datum) + ' negativ. Bitte Buchungen prüfen und ggf. stornieren.'; }
    else if (ENTRIES.length && LAST_BACKUP !== undefined && K.daysBetween((LAST_BACKUP || ENTRIES[0].erfasst || today).slice(0, 10), today) >= 7) {
      warn.hidden = false;
      warn.textContent = (LAST_BACKUP ? 'Letzte Datensicherung vor ' + K.daysBetween(LAST_BACKUP.slice(0, 10), today) + ' Tagen.' : 'Noch keine Datensicherung.') +
        ' Bitte unter „Kassenbuch“ → „Sichern und Steuerberater“ → „Datensicherung“ sichern.';
    }
    else if (openPast.length && +today.slice(8, 10) >= 5) {
      warn.hidden = false;
      warn.textContent = K.monthLabel(openPast[openPast.length - 1]) + ' ist noch nicht abgeschlossen. Bitte unter „Kassenbuch“ abschließen.';
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
    const foot = el('div', 'version', 'App-Version ' + APP_VERSION + ' · ' + (CHAIN.ok ? '✓ Daten in Ordnung' : '⚠ Daten fehlerhaft'));
    list.appendChild(foot);
  }

  // ---------- Formulare ----------
  const SATZ = [{ v: '19', l: '19 %' }, { v: '7', l: '7 %' }, { v: '0', l: '0 % / ohne Umsatzsteuer' }];
  const artOpts = (typ) => K.ARTEN[typ].map((a) => ({ v: a.key, l: a.label }));
  const hasVst = (typ) => (v) => { const a = K.artInfo(typ, v.art); return !!(a && a.vst); };
  const FORMS = {
    zbon: {
      title: { scan: 'Kassenabrechnung prüfen', manual: 'Kassenabrechnung eintragen' },
      fields: [
        { key: 'datum', label: 'Datum', type: 'date' },
        { key: 'znr', label: 'Abrechnungs-Nr. (oben auf dem Bon, z. B. #340)', type: 'int', placeholder: 'z. B. 340' }
      ].concat(K.ZBON.map((f) => ({ key: f.key, label: f.label + (f.sign < 0 ? ' (wird abgezogen)' : ''), type: 'money',
        more: ['gutschein', 'aus', 'ein', 'abl'].indexOf(f.key) >= 0 })))
    },
    ausgabe: {
      title: { scan: 'Ausgabe prüfen', manual: 'Geld aus der Kasse' },
      fields: [
        { key: 'datum', label: 'Datum', type: 'date' },
        { key: 'art', label: 'Wofür?', type: 'select', options: artOpts('ausgabe'), required: true },
        { key: 'text', label: 'Kurze Beschreibung', type: 'text', placeholder: 'z. B. Metro, Sparkasse', required: true },
        { key: 'betrag', label: 'Betrag (brutto)', type: 'money', required: true },
        { key: 'satz', label: 'Steuersatz auf dem Kassenzettel', type: 'select', options: SATZ.concat([{ v: 'mix', l: 'beides: 19 % und 7 %' }]), required: true, showIf: hasVst('ausgabe') },
        { key: 'b19', label: 'davon mit 19 %', type: 'money', showIf: (v) => hasVst('ausgabe')(v) && v.satz === 'mix' },
        { key: 'b7', label: 'davon mit 7 %', type: 'money', showIf: (v) => hasVst('ausgabe')(v) && v.satz === 'mix' },
        { key: 'eigenbeleg', label: 'Ich habe keinen Kassenzettel dafür', type: 'check' },
        { key: 'empfaenger', label: 'Empfänger (wer hat das Geld bekommen?)', type: 'text', required: true, showIf: (v) => v.eigenbeleg },
        { key: 'ohnegrund', label: 'Warum gibt es keinen Beleg?', type: 'text', required: true, placeholder: 'z. B. Parkautomat ohne Quittung', showIf: (v) => v.eigenbeleg }
      ]
    },
    einnahme: {
      title: { manual: 'Geld in die Kasse' },
      fields: [
        { key: 'datum', label: 'Datum', type: 'date' },
        { key: 'art', label: 'Woher?', type: 'select', options: artOpts('einnahme'), required: true },
        { key: 'text', label: 'Kurze Beschreibung', type: 'text', placeholder: 'z. B. Wechselgeld Sparkasse', required: true },
        { key: 'betrag', label: 'Betrag (brutto)', type: 'money', required: true },
        { key: 'satz', label: 'Steuersatz', type: 'select', options: SATZ, required: true, showIf: hasVst('einnahme') }
      ]
    },
    zaehlung: {
      title: { manual: 'Kassensturz' },
      fields: [
        { key: 'datum', label: 'Datum', type: 'date' },
        { key: 'ist', label: 'Gezähltes Bargeld in der Kasse', type: 'money', allowZero: true },
        { key: 'grund', label: 'Grund für die Differenz', type: 'text', required: true, placeholder: 'z. B. falsch herausgegeben, Ursache unbekannt',
          showIf: (v) => v.ist !== null && v.ist !== K.balanceAt(ENTRIES, START, v.datum || todayIso()) }
      ]
    },
    storno: {
      title: { manual: 'Buchung stornieren' },
      fields: [{ key: 'grund', label: 'Was war falsch?', type: 'text', placeholder: 'z. B. Betrag falsch eingetippt', required: true }]
    },
    start: {
      title: { edit: 'Kassenbuch einrichten' },
      fields: [
        { key: 'datum', label: 'Anfangsbestand: Stand vom', type: 'date', lock: true },
        { key: 'betrag', label: 'Anfangsbestand: Bargeld in der Kasse', type: 'money', allowZero: true, lock: true },
        { key: 'firma', label: 'Name des Geschäfts', type: 'text', placeholder: 'erscheint oben im Kassenbuch' },
        { key: 'anschrift', label: 'Anschrift', type: 'text', placeholder: 'Straße, PLZ Ort' },
        { key: 'steuernummer', label: 'Steuernummer', type: 'text', placeholder: 'optional' },
        { key: 'kassierer', label: 'Kassenführer (wer bucht auf diesem Handy?)', type: 'text', placeholder: 'Vor- und Nachname' }
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
    if (entry.typ === 'start') hint = locked ? 'Der Anfangsbestand ist fest. Die übrigen Angaben lassen sich ändern.'
      : 'Einmal das Bargeld in der Kasse zählen und eintragen.';
    else if (entry.typ === 'zbon') hint = opts.mode === 'scan' ? 'Bitte kurz mit dem Bon vergleichen.' : 'Beträge wie auf dem Bon. Leere Felder zählen als 0.';
    else if (entry.typ === 'zaehlung') hint = 'Alles Bargeld in der Kasse zählen und eintragen.';
    else if (entry.typ === 'storno') hint = 'Die alte Buchung bleibt sichtbar und wird aufgehoben.';
    else if (opts.mode === 'scan') hint = Object.keys(flagged).length ? 'Orange markierte Felder bitte prüfen.' : 'Stimmt alles? Dann speichern.';
    if (opts.korrekturVon) hint = 'Die alte Buchung ist gestrichen. Jetzt die richtigen Werte eintragen.';
    $('editorHint').textContent = hint;

    const box = $('fields');
    box.innerHTML = '';
    for (const f of form.fields) {
      const wrap = el('div', 'field' + (flagged[f.key] ? ' missing' : '') + (f.type === 'check' ? ' check' : ''));
      wrap.dataset.key = f.key;
      const id = 'f_' + f.key;
      const label = el('label', '', f.label + (f.type === 'money' ? ' (€)' : ''));
      label.htmlFor = id;
      let input;
      const v = entry[f.key];
      if (f.type === 'select') {
        input = document.createElement('select');
        input.appendChild(new Option('Bitte wählen …', ''));
        for (const o of f.options) input.appendChild(new Option(o.l, o.v));
        input.value = v === undefined || v === null ? '' : String(v);
      } else {
        input = document.createElement('input');
        if (f.type === 'date') { input.type = 'date'; input.value = v || ''; input.max = todayIso(); }
        else if (f.type === 'money') {
          input.type = 'text'; input.inputMode = 'decimal'; input.className = 'money'; input.autocomplete = 'off';
          input.placeholder = '0,00'; input.value = v ? P.formatCents(v) : (v === 0 && f.allowZero ? '0,00' : '');
        } else if (f.type === 'int') { input.type = 'text'; input.inputMode = 'numeric'; input.value = v || ''; input.placeholder = f.placeholder || ''; }
        else if (f.type === 'check') { input.type = 'checkbox'; input.checked = !!v; }
        else { input.type = 'text'; input.autocapitalize = 'sentences'; input.value = v || ''; input.placeholder = f.placeholder || ''; }
      }
      input.id = id; input.name = f.key;
      if (locked && f.lock) input.disabled = true;
      const changed = () => { wrap.classList.remove('missing'); const n = wrap.querySelector('.note'); if (n) n.remove(); updateVisibility(); updateCalc(); };
      input.addEventListener('input', changed);
      input.addEventListener('change', changed);
      if (f.type === 'check') wrap.append(input, label); else wrap.append(label, input);
      if (flagged[f.key]) wrap.appendChild(el('div', 'note', flagged[f.key]));
      box.appendChild(wrap);
    }
    // Selten gebrauchte Felder hinter „Weitere Felder“
    const moreF = form.fields.filter((f) => f.more);
    if (moreF.length) {
      const b = el('button', 'link muted more-btn', 'Weitere Felder: ' + moreF.map((f) => f.label.replace(/ \(.*\)$/, '')).join(', '));
      b.type = 'button';
      b.addEventListener('click', () => { editing.showMore = true; b.hidden = true; updateVisibility(); });
      box.appendChild(b);
      b.hidden = moreF.every((f) => filled(entry[f.key]));
    }
    updateVisibility();
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

  // Aktuelle Formularwerte (für bedingte Felder)
  function formValues() {
    const out = {};
    for (const f of FORMS[editing.entry.typ].fields) {
      const i = $('f_' + f.key);
      if (!i) continue;
      out[f.key] = f.type === 'check' ? i.checked : f.type === 'money' ? readMoney(i.value) : i.value;
    }
    return out;
  }
  const filled = (v) => v !== null && v !== undefined && v !== '' && v !== false;
  const isShown = (f, vals) => (!f.more || (editing && editing.showMore) || filled(vals[f.key])) && (!f.showIf || f.showIf(vals));
  function updateVisibility() {
    if (!editing) return;
    const vals = formValues();
    for (const f of FORMS[editing.entry.typ].fields) {
      const w = document.querySelector('.field[data-key="' + f.key + '"]');
      if (w) w.hidden = !isShown(f, vals);
    }
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
    const vals = formValues();
    for (const f of FORMS[typ].fields) {
      const input = $('f_' + f.key);
      if (locked && f.lock) continue;
      if (!isShown(f, vals)) { delete out[f.key]; continue; }
      let v = f.type === 'check' ? input.checked : input.value.trim();
      if (f.type === 'money') {
        const c = readMoney(v);
        if (v && (c === null || c < 0)) { mark(input, 'Bitte als Betrag eingeben, z. B. 12,50'); ok = false; continue; }
        if (f.required && !c) { mark(input, 'Bitte Betrag eintragen'); ok = false; continue; }
        if (f.allowZero && c === null) { mark(input, 'Bitte eintragen (auch 0 ist möglich)'); ok = false; continue; }
        v = c;
      }
      if (f.type === 'int') {
        if (v && !/^\d{1,6}$/.test(v.replace(/^#/, ''))) { mark(input, 'Bitte nur die Nummer eintragen, z. B. 340'); ok = false; continue; }
        v = v ? parseInt(v.replace(/^#/, ''), 10) : '';
      }
      if ((f.type === 'text' || f.type === 'select') && f.required && !v) { mark(input, f.type === 'select' ? 'Bitte auswählen' : 'Bitte ausfüllen'); ok = false; continue; }
      if (f.type === 'select' && f.key === 'satz' && v !== 'mix' && v !== '') v = +v;
      if (f.type === 'check' && !v) { delete out[f.key]; continue; }
      if (f.type === 'date') {
        const err = typ === 'start' ? (!v ? 'Bitte Datum wählen' : v > todayIso() ? 'Datum liegt in der Zukunft' : null)
          : K.checkDate(v, CLOSED, todayIso()) || (START && v < START.datum ? 'Liegt vor dem Anfangsbestand (' + deDate(START.datum) + ')' : null);
        if (err) { mark(input, err); ok = false; continue; }
      }
      out[f.key] = v === '' ? null : v;
    }
    if (ok && out.satz === 'mix') {
      if (!(out.b19 || out.b7)) { mark($('f_b19'), 'Bitte die Anteile eintragen'); ok = false; }
      else if ((out.b19 || 0) + (out.b7 || 0) > (out.betrag || 0)) { mark($('f_b7'), 'Die Anteile sind größer als der Betrag'); ok = false; }
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
      if (typ === 'zbon') {
        if (!out.znr && !confirm('Ohne Abrechnungs-Nr. speichern? Die Nummer steht oben auf dem Bon (z. B. #340) und hilft, fehlende Tage zu erkennen.')) return;
        const zc = K.znrCheck(ENTRIES, out.znr);
        if (zc.doppelt && !confirm('Abrechnung #' + out.znr + ' ist schon gebucht (Beleg ' + K.belegNr(zc.doppelt) + ' vom ' + deDate(zc.doppelt.datum) + '). Wirklich noch einmal buchen?')) return;
        if (zc.luecke && !confirm('Es fehlt ' + (zc.luecke[0] === zc.luecke[1] ? 'Abrechnung #' + zc.luecke[0] : 'Abrechnung #' + zc.luecke[0] + ' bis #' + zc.luecke[1]) +
          '. Bitte fehlende Abrechnungen zuerst buchen. Trotzdem speichern?')) return;
      }
      const neg = K.dayBalances(ENTRIES.concat([Object.assign({ nr: 1e9 }, out)]), START).find((d) => d.bestand < 0);
      if (neg && !confirm('Mit dieser Buchung wird der Kassenbestand am ' + deDate(neg.datum) + ' negativ (' + eur(neg.bestand) + '). Das deutet auf einen Fehler hin. Trotzdem speichern?')) return;

      if (opts.korrekturVon) out.korrektur_von = opts.korrekturVon;
      const e = await book(out, opts.photo);
      closeEditor();
      await reload();
      toast('Gespeichert ✓');
    } finally { saving = false; }
  }

  async function saveStart(out, locked) {
    const prev = START;
    const info = { firma: out.firma || '', anschrift: out.anschrift || '', steuernummer: out.steuernummer || '', kassierer: out.kassierer || '' };
    const next = locked ? Object.assign({}, prev, info) : Object.assign({ datum: out.datum, betrag: out.betrag || 0 }, info);
    await setSetting('anfangsbestand', next);
    if (!locked && (!prev || prev.betrag !== next.betrag || prev.datum !== next.datum)) {
      await log('Anfangsbestand festgelegt: ' + eur(next.betrag) + ' zum ' + deDate(next.datum));
    }
    if (prev && (prev.kassierer || '') !== next.kassierer) await log('Kassenführer: ' + (next.kassierer || '(leer)'));
    closeEditor(); await reload(); toast('Gespeichert');
  }

  async function saveStorno(target, grund, then) {
    const s = K.makeStorno(target, grund, K.closedUntil(CLOSED), todayIso());
    const e = await book(s);
    closeEditor();
    await reload();
    toast('Buchung gestrichen');
    if (then === 'fix') {
      const copy = {};
      for (const k of ['typ', 'datum', 'text', 'betrag', 'art', 'satz', 'b19', 'b7', 'znr', 'eigenbeleg', 'empfaenger', 'ohnegrund'].concat(K.ZBON.map((f) => f.key))) if (target[k] !== undefined) copy[k] = target[k];
      if (K.checkDate(copy.datum, CLOSED, todayIso())) copy.datum = todayIso();
      openEditor(copy, { mode: 'manual', korrekturVon: target.nr, title: 'Richtige Werte eintragen' });
    }
  }

  async function saveZaehlung(out) {
    out.soll = K.balanceAt(ENTRIES, START, out.datum);
    const z = await book(out);
    const d = out.ist - out.soll;
    let msg = 'Kassensturz gebucht (Beleg ' + K.belegNr(z) + ')';
    if (d) {
      const k = await book({ typ: d > 0 ? 'einnahme' : 'ausgabe', art: 'kassendiff', satz: null, datum: out.datum,
        text: 'Kassendifferenz laut Kassensturz Beleg ' + K.belegNr(z) + (out.grund ? ': ' + out.grund : ''), betrag: Math.abs(d) });
      msg += ', Differenz ' + eur(d) + ' als Beleg ' + K.belegNr(k);
    }
    closeEditor(); await reload(); toast(msg, 4000);
  }

  function openStart() {
    openEditor(Object.assign({ typ: 'start', datum: todayIso(), betrag: null }, START || {}, { typ: 'start' }), { mode: 'edit' });
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
    if (e.typ === 'zaehlung') { row('Gezählt', eur(e.ist)); row('Soll', eur(e.soll)); row('Differenz', eur(e.ist - e.soll)); if (e.grund) row('Grund', e.grund); }
    if (e.znr) row('Abrechnungs-Nr.', '#' + e.znr);
    const ai = K.artInfo(e.typ, e.art);
    if (ai) row('Art', ai.label);
    if (e.eigenbeleg) { row('Eigenbeleg', 'kein Fremdbeleg vorhanden'); row('Empfänger', e.empfaenger || ''); row('Grund', e.ohnegrund || ''); }
    if (e.kassierer) row('Gebucht von', e.kassierer);
    for (const l of K.lines(e)) {
      if (l.info) continue;
      const a = l.ein - l.aus;
      row(l.text.replace(/^Kassenabrechnung (#\d+ )?/, '') + (l.satz ? ' · ' + (l.vst ? 'VSt' : 'USt') + ' ' + eur(l.ust) : ''), (a > 0 ? '+' : '') + eur(a));
    }
    const locked = !!K.checkDate(e.datum, CLOSED, todayIso()) && e.datum <= todayIso();

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
    $('detailStorno').onclick = () => { closeDetail(); openEditor({ typ: 'storno' }, { mode: 'manual', target: e, then: 'only', title: 'Buchung streichen' }); };
    $('detailFix').onclick = () => { closeDetail(); openEditor({ typ: 'storno' }, { mode: 'manual', target: e, then: 'fix', title: 'Fehler korrigieren' }); };
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
      const opts = [];
      if (m && closable.indexOf(m) >= 0) opts.push({ label: 'Monat abschließen', sub: 'Am Monatsende einmal machen. Danach ist der Monat fest.', run: () => closeMonth(m) });
      opts.push({ label: 'Kassenbuch als PDF', sub: 'Zum Ausdrucken oder für den Steuerberater', run: () => exportPdf(m, false) });
      opts.push({ label: 'Mehr …', sub: 'PDF mit Bonfotos, Excel-Tabelle', run: () => choose(m ? K.monthLabel(m) : 'Alle Buchungen', '', [
        { label: 'PDF mit Bonfotos', sub: 'Jedes Bonfoto als eigene Seite', run: () => exportPdf(m, true) },
        { label: 'Excel-Tabelle', sub: 'Zum Weiterrechnen', run: () => exportExcel(m) }
      ]) });
      choose(m ? K.monthLabel(m) : 'Alle Buchungen', m ? (isClosed(m) ? 'abgeschlossen 🔒' : closable.indexOf(m) >= 0 ? 'noch nicht abgeschlossen' : 'laufender Monat') : '', opts);
    };
    const opts = months.map((m) => ({ label: K.monthLabel(m) + (isClosed(m) ? ' 🔒' : ''), run: pick(m) }));
    opts.push({ label: 'Sichern und Steuerberater', sub: 'Datensicherung, Prüfsumme, alle Buchungen', run: () => choose('Sichern und Steuerberater', '', [
      { label: 'Datensicherung', sub: 'Alle Daten und Fotos als Datei – z. B. per Mail an euch selbst schicken', run: backup },
      { label: 'Prüfsumme senden', sub: 'Kurzer Nachweis des aktuellen Stands, z. B. an den Steuerberater', run: shareHash },
      { label: 'Alle Buchungen', sub: 'Kassenbuch vom Anfang bis heute', run: pick(null) }
    ]) });
    choose('Kassenbuch', 'Welcher Monat?', opts);
  }
  const isClosed = (m) => !!(CLOSED[m] || (K.closedUntil(CLOSED) && m <= K.closedUntil(CLOSED)));

  async function closeMonth(m) {
    if (!CHAIN.ok) { toast('Prüfsummen sind fehlerhaft – Abschluss nicht möglich'); return; }
    const earlier = K.closableMonths(ENTRIES, START, CLOSED, todayIso()).filter((x) => x <= m);
    const names = earlier.map(K.monthLabel).join(', ');
    if (!confirm(names + ' abschließen?\n\nDanach kann in diesem Monat nichts mehr gebucht oder geändert werden. Bitte vorher prüfen, ob alle Kassenabrechnungen drin sind.')) return;
    const info = { am: new Date().toISOString(), hash: K.lastHash(ENTRIES), bisNr: K.nextNr(ENTRIES) - 1 };
    for (const x of earlier) CLOSED[x] = info;
    await setSetting('festgeschrieben', CLOSED);
    for (const x of earlier) await log(K.monthLabel(x) + ' festgeschrieben (bis Beleg ' + String(info.bisNr).padStart(4, '0') + ')', x);
    await reload();
    toast(names + ' abgeschlossen 🔒', 3500);
    choose(K.monthLabel(m) + ' abgeschlossen 🔒', 'Jetzt das Kassenbuch an den Steuerberater schicken:', [
      { label: 'Kassenbuch als PDF', run: () => exportPdf(m, false) },
      { label: 'PDF mit Bonfotos', run: () => exportPdf(m, true) }
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
      firma: START.firma || '', anschrift: START.anschrift || '', steuernummer: START.steuernummer || '', closed: CLOSED, chain: CHAIN, protokoll: proto, fotos: fotos
    });
    const blob = new Blob([out.bytes], { type: 'application/pdf' });
    const name = (month ? 'Kassenbuch_' + month : 'Kassenbuch_gesamt_' + todayIso()) + (withPhotos ? '_mit_Belegen' : '') + '.pdf';
    await deliver(blob, name, 'Kassenbuch ' + (month ? K.monthLabel(month) : 'gesamt'));
  }

  // ---------- Datensicherung (maschinell auswertbar) und Prüfsummen-Nachweis ----------
  const csvCell = (v) => { v = v === null || v === undefined ? '' : String(v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const csvMoney = (c) => c ? (c / 100).toFixed(2).replace('.', ',') : '';

  function journalCsv() {
    const head = ['Beleg', 'Buchungsdatum', 'Erfasst', 'Typ', 'Art', 'Buchungstext', 'Einnahme', 'Ausgabe', 'Steuersatz', 'USt', 'VSt',
      'Abrechnungs_Nr', 'Storno_zu_Beleg', 'Storniert_durch', 'Grund', 'Eigenbeleg', 'Empfaenger', 'Grund_ohne_Beleg', 'Kassenfuehrer', 'Foto_SHA256', 'Pruefsumme_SHA256'];
    const sm = K.stornoMap(ENTRIES);
    const rows = [head.join(';')];
    for (const e of K.sortEntries(ENTRIES)) {
      for (const l of K.lines(e)) {
        rows.push([K.belegNr(e), e.datum, e.erfasst, K.TYP_NAME[e.typ] || e.typ, l.art || '', l.text, csvMoney(l.ein), csvMoney(l.aus),
          l.satz === null || l.satz === undefined ? '' : l.satz, l.vst ? '' : csvMoney(l.ust), l.vst ? csvMoney(l.ust) : '',
          e.znr || '', e.ref ? String(e.ref).padStart(4, '0') : '', sm[e.nr] ? K.belegNr(sm[e.nr]) : '', e.grund || '',
          e.eigenbeleg ? 'ja' : '', e.empfaenger || '', e.ohnegrund || '', e.kassierer || '', e.fotoHash || '', e.hash || ''].map(csvCell).join(';'));
      }
    }
    return '\ufeff' + rows.join('\r\n') + '\r\n';
  }

  async function backup() {
    toast('Datensicherung wird erstellt …', 2000);
    const enc = new TextEncoder();
    const now = new Date();
    const stamp = now.toISOString();
    const files = [];
    const proto = await allProtokoll();
    const data = { format: 'kassenbuch-app', app_version: APP_VERSION, erstellt: stamp, anfangsbestand: START, festgeschrieben: CLOSED,
      pruefsummen: { verfahren: 'SHA-256 über die kanonische Form je Buchung, verkettet über das Feld prev', ok: CHAIN.ok, buchungen: CHAIN.count, letzte: CHAIN.last || null },
      protokoll: proto, buchungen: K.sortEntries(ENTRIES).sort((a, b) => a.nr - b.nr).map((e) => { const c = Object.assign({}, e); delete c.id; return c; }) };
    files.push({ name: 'buchungsjournal.csv', data: enc.encode(journalCsv()) });
    files.push({ name: 'kassenbuch.json', data: enc.encode(JSON.stringify(data, null, 2)) });
    let n = 0;
    for (const e of ENTRIES) {
      if (!e.fotoHash) continue;
      const b = await getBeleg(e.nr);
      if (b) { files.push({ name: 'belege/' + K.belegNr(e) + '.jpg', data: new Uint8Array(await b.blob.arrayBuffer()) }); n++; }
    }
    files.push({ name: 'pruefsumme.txt', data: enc.encode(hashText(now) + '\r\n') });
    files.push({ name: 'LIESMICH.txt', data: enc.encode([
      'Datensicherung Kassenbuch-App vom ' + deStamp(stamp),
      '',
      'buchungsjournal.csv  Alle Buchungszeilen (Semikolon-getrennt, UTF-8), maschinell auswertbar',
      'kassenbuch.json      Alle Daten unverändert, inkl. Prüfsummen, Protokoll, Festschreibungen',
      'belege/              Fotos der Kassenabrechnungen (Dateiname = Belegnummer)',
      'pruefsumme.txt       Stand und Prüfsumme der letzten Buchung',
      '',
      'Jede Buchung trägt eine SHA-256-Prüfsumme (hash) und die Prüfsumme der vorherigen Buchung (prev).',
      'Fotos sind über Foto_SHA256 mit der Buchung verbunden.'
    ].join('\r\n')) });
    const blob = window.XlsxLite.zip(files, 'application/zip');
    await setSetting('letzteSicherung', stamp);
    await log('Datensicherung erstellt: ' + ENTRIES.length + ' Buchungen, ' + n + ' Fotos, Prüfsumme ' + (CHAIN.last || '').slice(0, 16) + '…');
    await deliver(blob, 'Kassenbuch_Sicherung_' + todayIso() + '.zip', 'Kassenbuch Datensicherung');
    await reload();
  }

  function hashText(now) {
    const last = ENTRIES.reduce((m, e) => (!m || e.nr > m.nr ? e : m), null);
    return 'Kassenbuch ' + (START && START.firma ? START.firma + ' ' : '') + '– Stand ' + deStamp((now || new Date()).toISOString()) + ': ' +
      ENTRIES.length + ' Buchungen, letzte Buchung Beleg ' + (last ? K.belegNr(last) + ' vom ' + deDate(last.datum) : '–') +
      ', Prüfsummen ' + (CHAIN.ok ? 'in Ordnung' : 'FEHLERHAFT') + '. SHA-256 der letzten Buchung: ' + (CHAIN.last || '–');
  }

  async function shareHash() {
    const text = hashText();
    if (navigator.share) {
      try { await navigator.share({ title: 'Kassenbuch Prüfsumme', text: text }); await log('Prüfsumme geteilt: ' + (CHAIN.last || '').slice(0, 16) + '…'); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(text); toast('Prüfsumme kopiert – z. B. in eine Mail einfügen', 3500); }
    catch (e) { alert(text); }
    await log('Prüfsumme kopiert: ' + (CHAIN.last || '').slice(0, 16) + '…');
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
    $('manualBtn').addEventListener('click', needStart(() => choose('Eintragen', 'Was ist passiert?', [
      { label: 'Geld aus der Kasse genommen', sub: 'Einkauf bezahlt, zur Bank gebracht, privat entnommen', run: () => openEditor({ typ: 'ausgabe', datum: todayIso() }, { mode: 'manual' }) },
      { label: 'Geld in die Kasse gelegt', sub: 'Wechselgeld von der Bank, Privateinlage', run: () => openEditor({ typ: 'einnahme', datum: todayIso() }, { mode: 'manual' }) },
      { label: 'Kasse gezählt', sub: 'Bargeld zählen und vergleichen (Kassensturz)', run: () => openEditor({ typ: 'zaehlung', datum: todayIso() }, { mode: 'manual' }) },
      { label: 'Kassenabrechnung aus der Galerie', sub: 'Ein schon gemachtes Foto verwenden', run: () => $('galleryInput').click() },
      { label: 'Kassenabrechnung abtippen', sub: 'Wenn das Foto nicht klappt', run: () => openEditor({ typ: 'zbon', datum: todayIso() }, { mode: 'manual' }) }
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
