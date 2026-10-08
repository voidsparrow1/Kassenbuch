/* Fertiges Kassenbuch als PDF (A4 quer): Kopf, lfd. Nr., Beleg, Übertrag, Seitensummen,
   Monatsabschluss mit USt-Übersicht und Unterschriftsfeld. Braucht Kassenbuch (kassenbuch.js) und PdfLite (pdf.js). */
(function (root) {
  'use strict';
  const K = root.Kassenbuch || (typeof require !== 'undefined' ? require('./kassenbuch.js') : null);
  const PdfLite = root.PdfLite || (typeof require !== 'undefined' ? require('./pdf.js') : null);

  const pad = function (v, len) { return String(v).padStart(len || 2, '0'); };
  const de = function (iso) { return iso ? iso.split('-').reverse().join('.') : ''; };
  function money(c) {
    if (c === null || c === undefined) return '';
    const neg = c < 0; c = Math.abs(Math.round(c));
    const e = Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (neg ? '–' : '') + e + ',' + pad(c % 100);
  }
  function lastDay(ym) { const p = ym.split('-').map(Number); return ym + '-' + pad(new Date(Date.UTC(p[0], p[1], 0)).getUTCDate()); }

  // Spalten (x-Positionen, A4 quer = 842 × 595 pt)
  const L = 36, R = 806;
  const COL = {
    nr: { x: 58, align: 'right', title: 'Nr.' },
    datum: { x: 66, title: 'Datum' },
    beleg: { x: 122, title: 'Beleg' },
    art: { x: 168, w: 64, title: 'Art' },
    text: { x: 236, w: 212, title: 'Buchungstext' },
    ein: { x: 512, align: 'right', title: 'Einnahme €' },
    aus: { x: 590, align: 'right', title: 'Ausgabe €' },
    satz: { x: 632, align: 'right', title: 'USt %' },
    ust: { x: 700, align: 'right', title: 'USt/VSt €' },
    bestand: { x: R - 4, align: 'right', title: 'Bestand €' }
  };
  const ROW = 15, TOP = 112, BOTTOM = 540;

  // Zeilen fürs Belegverzeichnis: jede Buchung des Zeitraums mit Erfassungszeit und Hinweisen
  function registerRows(inPeriod, all, opts) {
    const sm = K.stornoMap(all);
    const byNr = {};
    for (const e of all) byNr[e.nr] = e;
    const ts = function (iso) {
      if (!iso) return '';
      const d = new Date(iso);
      return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    };
    const out = inPeriod.slice().sort(function (a, b) { return (a.nr || 0) - (b.nr || 0); }).map(function (e) {
      const h = [];
      let warn = false;
      if (e.typ === 'storno') h.push('Storno zu Beleg ' + pad(e.ref, 4) + ' – Grund: ' + (e.grund || ''));
      if (sm[e.nr]) { h.push('storniert durch Beleg ' + pad(sm[e.nr].nr, 4)); }
      if (e.korrektur_von) h.push('Korrektur zu Beleg ' + pad(e.korrektur_von, 4));
      if (e.typ === 'zaehlung') { const d = (e.ist || 0) - (e.soll || 0); h.push(d ? 'Differenz ' + money(d) + ' €' : 'kein Unterschied'); if (d) warn = true; }
      if (e.nachtraeglich) { h.push('nachträglich erfasst'); warn = true; }
      if (e.znr) h.push('Abrechnung #' + e.znr);
      if (e.eigenbeleg) { h.push('Eigenbeleg – Empfänger: ' + (e.empfaenger || '?') + ', ohne Beleg weil: ' + (e.ohnegrund || '?')); warn = true; }
      if (e.typ === 'zaehlung' && e.grund) h.push('Grund: ' + e.grund);
      if (e.fotoHash) h.push('Foto gespeichert');
      if (e.kassierer) h.push('erfasst von ' + e.kassierer);
      if (e.text && /kassendifferenz/i.test(e.text)) { warn = true; h.push('Kassendifferenz aus Kassensturz'); }
      return { beleg: K.belegNr(e), art: K.TYP_NAME[e.typ] || e.typ, datum: de(e.datum), erfasst: ts(e.erfasst), hinweis: h.join(' · '), warn: warn };
    });
    const z = inPeriod.filter(function (e) { return e.typ === 'zbon' && e.znr; }).map(function (e) { return +e.znr; });
    if (z.length) {
      const lo = Math.min.apply(null, z), hi = Math.max.apply(null, z);
      for (const g of K.znrGaps(all)) {
        if (g[1] < lo - 1 || g[0] > hi + 1) continue;
        out.push({ beleg: '–', art: 'Prüfung', datum: '', erfasst: '', hinweis: 'Lücke in den Abrechnungs-Nummern: ' + (g[0] === g[1] ? '#' + g[0] : '#' + g[0] + ' bis #' + g[1]) + ' fehlt', warn: true });
      }
    }
    for (const ev of opts.protokoll || []) {
      out.push({ beleg: '–', art: 'Protokoll', datum: '', erfasst: ts(ev.am), hinweis: ev.text, warn: false });
    }
    if (!out.length) out.push({ beleg: '', art: '', datum: '', erfasst: '', hinweis: 'Keine Buchungen im Zeitraum.' });
    return out;
  }
  function padN(v, n) { return String(v).padStart(n, '0'); }

  /* entries/start wie in der App; month '2026-10' oder null (alles).
     opts: { firma, erstellt (Date), closed ({monat: {am, hash, bisNr}}), chain ({ok, count, last, at, grund}),
             protokoll ([{am, text}]), fotos ([{nr, jpeg: Uint8Array, w, h}]) } */
  function build(entries, start, month, opts) {
    opts = opts || {};
    const sorted = K.sortEntries(entries);
    const from = month ? month + '-01' : null;
    const to = month ? lastDay(month) : null;
    let opening = start ? start.betrag || 0 : 0;
    const rows = [], inPeriod = [];
    for (const e of sorted) {
      if (from && (e.datum || '') < from) { opening += K.net(e); continue; }
      if (to && (e.datum || '') > to) continue;
      const beleg = K.belegNr(e) || ('B-' + (e.id || ''));
      inPeriod.push(e);
      for (const l of K.lines(e)) rows.push(Object.assign({ beleg: beleg }, l));
    }

    const period = month ? K.monthLabel(month) : 'Gesamtzeitraum';
    const doc = new PdfLite.Doc({ landscape: true, title: 'Kassenbuch ' + period });
    const now = opts.erstellt || new Date();
    const stampOf = function (d) { return de(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
    const stamp = stampOf(now);

    // Seiten vorab aufteilen, damit "Seite x von y" stimmt
    const perPage = Math.floor((BOTTOM - TOP - 2 * ROW) / ROW);   // Platz für Übertrag oben + Seitensumme unten
    const SUMMARY_H = 220;
    const chunks = [];
    for (let i = 0; i < rows.length; i += perPage) chunks.push(rows.slice(i, i + perPage));
    if (!chunks.length) chunks.push([]);
    const lastRowsY = TOP + (chunks[chunks.length - 1].length + 2) * ROW;
    const summaryOwnPage = lastRowsY + SUMMARY_H > BOTTOM + 40;
    // Anhang: Belegverzeichnis/Protokoll (eigene Seiten) und optional Belegfotos
    const reg = registerRows(inPeriod, entries, opts);
    const REG_PER_PAGE = Math.floor((BOTTOM - TOP - 4 * ROW) / ROW);
    const regPages = Math.max(1, Math.ceil(reg.length / REG_PER_PAGE));
    const fotos = (opts.fotos || []).filter(function (f) { return inPeriod.some(function (e) { return e.nr === f.nr; }); });
    const total = chunks.length + (summaryOwnPage ? 1 : 0) + regPages + fotos.length;

    const closedInfo = month && opts.closed && opts.closed[month];
    const status = !month ? 'Auszug, nicht festgeschrieben'
      : closedInfo ? 'Festgeschrieben am ' + stampOf(new Date(closedInfo.am)) : 'VORLÄUFIG – Monat noch nicht abgeschlossen';
    let bal = opening, nr = 0, sumEin = 0, sumAus = 0;
    const u = { 19: { brutto: 0, ust: 0 }, 7: { brutto: 0, ust: 0 }, 0: { brutto: 0, ust: 0 } };   // Umsatzsteuer (Einnahmen)
    const v = { 19: { brutto: 0, ust: 0 }, 7: { brutto: 0, ust: 0 }, 0: { brutto: 0, ust: 0 } };   // Vorsteuer (Ausgaben)

    function header(pageNo, noCols) {
      doc.addPage({ landscape: true });
      doc.text(L, 46, 'Kassenbuch', { size: 18, bold: true });
      if (opts.firma) doc.text(L + 112, 46, opts.firma, { size: 12, maxWidth: 400 });
      doc.text(R, 40, period, { size: 12, bold: true, align: 'right' });
      doc.text(R, 54, 'Seite ' + pageNo + ' von ' + total, { size: 8.5, align: 'right', gray: 0.35 });
      const z = month ? de(from) + ' – ' + de(to) : '';
      const kopf = [z ? 'Zeitraum ' + z : '', opts.anschrift || '', opts.steuernummer ? 'St.-Nr. ' + opts.steuernummer : ''].filter(Boolean).join('  ·  ');
      if (kopf) doc.text(L, 62, kopf, { size: 8.5, gray: 0.35, maxWidth: 560 });
      doc.text(R, 66, status, { size: 8.5, bold: !closedInfo, align: 'right', gray: closedInfo ? 0.2 : 0 });
      if (noCols) return;
      doc.rect(L, 74, R - L, 18, { fill: 0.9 });
      for (const k in COL) {
        const c = COL[k];
        doc.text(c.x, 86, c.title, { size: 8, bold: true, align: c.align });
      }
      doc.line(L, 92, R, 92, { width: 0.8 });
    }
    function footer() {
      doc.line(L, 560, R, 560, { gray: 0.6, width: 0.4 });
      doc.text(L, 572, 'Erstellt mit der Kassenbuch-App am ' + stamp + '. Beträge in Euro, brutto.', { size: 7, gray: 0.45 });
    }
    function balRow(y, label) {
      doc.text(COL.text.x, y, label, { size: 8.5, bold: true });
      doc.text(COL.bestand.x, y, money(bal), { size: 8.5, bold: true, align: 'right' });
    }

    chunks.forEach(function (chunk, pi) {
      header(pi + 1);
      let y = TOP;
      balRow(y, pi === 0 ? (month ? 'Übertrag / Anfangsbestand' : 'Anfangsbestand') : 'Übertrag von Seite ' + pi);
      y += ROW;
      let pEin = 0, pAus = 0;
      chunk.forEach(function (r, i) {
        nr++;
        bal += r.ein - r.aus; sumEin += r.ein; sumAus += r.aus; pEin += r.ein; pAus += r.aus;
        if (r.satz !== null && r.satz !== undefined && u[r.satz]) {
          if (r.vst) { v[r.satz].brutto += r.aus; v[r.satz].ust += r.ust; } else { u[r.satz].brutto += r.ein; u[r.satz].ust += r.ust; }
        }
        if (i % 2 === 1) doc.rect(L, y - 10.5, R - L, ROW, { fill: 0.965 });
        doc.text(COL.nr.x, y, nr, { size: 8.5, align: 'right', gray: 0.35 });
        doc.text(COL.datum.x, y, de(r.datum), { size: 8.5 });
        doc.text(COL.beleg.x, y, r.beleg, { size: 8.5, maxWidth: 44 });
        doc.text(COL.art.x, y, r.art || '', { size: 7.5, maxWidth: COL.art.w, gray: 0.25 });
        doc.text(COL.text.x, y, r.text, { size: 8.5, maxWidth: COL.text.w });
        if (r.ein) doc.text(COL.ein.x, y, money(r.ein), { size: 8.5, align: 'right' });
        if (r.aus) doc.text(COL.aus.x, y, money(r.aus), { size: 8.5, align: 'right' });
        if (r.storno) doc.line(COL.text.x, y + 2.5, COL.text.x + 34, y + 2.5, { width: 0.4, gray: 0.5 });
        if (r.satz !== null && r.satz !== undefined) doc.text(COL.satz.x, y, r.satz + ' %', { size: 8.5, align: 'right' });
        if (r.satz) doc.text(COL.ust.x, y, money(r.ust), { size: 8.5, align: 'right' });
        doc.text(COL.bestand.x, y, money(bal), { size: 8.5, align: 'right', bold: bal < 0 });
        y += ROW;
      });
      if (!chunk.length) { doc.text(COL.text.x, y, 'Keine Buchungen in diesem Zeitraum.', { size: 8.5, gray: 0.4 }); y += ROW; }
      // Seitensumme
      doc.line(L, y - 9, R, y - 9, { width: 0.6 });
      doc.text(COL.text.x, y + 2, 'Summe Seite ' + (pi + 1), { size: 8.5, bold: true });
      doc.text(COL.ein.x, y + 2, money(pEin), { size: 8.5, bold: true, align: 'right' });
      doc.text(COL.aus.x, y + 2, money(pAus), { size: 8.5, bold: true, align: 'right' });
      doc.text(COL.bestand.x, y + 2, money(bal), { size: 8.5, bold: true, align: 'right' });
      if (pi < chunks.length - 1) doc.text(COL.bestand.x, y + 14, 'Übertrag auf Seite ' + (pi + 2), { size: 7, align: 'right', gray: 0.45 });
      footer();
      if (pi === chunks.length - 1) summary(summaryOwnPage ? null : y + 34);
    });
    let pageNo = chunks.length + (summaryOwnPage ? 1 : 0);
    register();
    fotos.forEach(foto);

    function register() {
      const RC = { beleg: L + 4, art: L + 52, datum: L + 140, erfasst: L + 206, hinweis: L + 300 };
      for (let p = 0; p < regPages; p++) {
        pageNo++;
        header(pageNo, true);
        doc.text(L, 86, 'Belegverzeichnis und Protokoll', { size: 10, bold: true });
        let y = TOP;
        doc.rect(L, y - 11, R - L, 15, { fill: 0.93 });
        doc.text(RC.beleg, y, 'Beleg', { size: 8, bold: true });
        doc.text(RC.art, y, 'Art', { size: 8, bold: true });
        doc.text(RC.datum, y, 'Buchungsdatum', { size: 8, bold: true });
        doc.text(RC.erfasst, y, 'Erfasst am', { size: 8, bold: true });
        doc.text(RC.hinweis, y, 'Hinweise', { size: 8, bold: true });
        y += ROW;
        reg.slice(p * REG_PER_PAGE, (p + 1) * REG_PER_PAGE).forEach(function (r) {
          doc.text(RC.beleg, y, r.beleg, { size: 8 });
          doc.text(RC.art, y, r.art, { size: 8, maxWidth: 84 });
          doc.text(RC.datum, y, r.datum, { size: 8 });
          doc.text(RC.erfasst, y, r.erfasst, { size: 8 });
          doc.text(RC.hinweis, y, r.hinweis, { size: 8, maxWidth: R - RC.hinweis, gray: r.warn ? 0 : 0.25, bold: !!r.warn });
          y += ROW;
        });
        if (p === regPages - 1) {
          y += 8;
          const ch = opts.chain;
          doc.line(L, y - 10, R, y - 10, { width: 0.5 });
          if (ch) {
            doc.text(L + 4, y + 2, ch.ok ? 'Prüfsummen-Kette (SHA-256) über alle ' + ch.count + ' Buchungen: in Ordnung.'
              : 'ACHTUNG: Prüfsummen-Kette unterbrochen bei Beleg ' + pad(ch.at || 0, 4) + ' (' + ch.grund + '). Daten wurden außerhalb der App verändert.',
              { size: 8.5, bold: true });
            if (ch.ok && ch.last) doc.text(L + 4, y + 14, 'Prüfsumme der letzten Buchung: ' + ch.last, { size: 7, gray: 0.3 });
          }
          if (closedInfo && closedInfo.hash) doc.text(L + 4, y + 26, 'Festgeschrieben bis Beleg ' + pad(closedInfo.bisNr || 0, 4) + ' mit Prüfsumme ' + closedInfo.hash, { size: 7, gray: 0.3 });
          doc.text(L + 4, y + 42, 'Buchungen können nicht geändert oder gelöscht werden. Korrekturen erfolgen ausschließlich über Stornobuchungen mit Begründung.', { size: 7.5, gray: 0.35 });
        }
        footer();
      }
    }

    function foto(f) {
      pageNo++;
      doc.addPage({ portrait: true });
      const e = inPeriod.find(function (x) { return x.nr === f.nr; });
      doc.text(36, 40, 'Beleg ' + pad(f.nr, 4) + ' – ' + (K.TYP_NAME[e.typ] || '') + ' vom ' + de(e.datum), { size: 11, bold: true });
      doc.text(559, 40, 'Seite ' + pageNo + ' von ' + total, { size: 8, align: 'right', gray: 0.35 });
      doc.text(36, 54, 'Foto gespeichert am ' + stampOf(new Date(e.erfasst || Date.now())) + (e.fotoHash ? ' · SHA-256 ' + e.fotoHash.slice(0, 32) + '…' : ''), { size: 7.5, gray: 0.35 });
      const maxW = 523, maxH = 760;
      const sc = Math.min(maxW / f.w, maxH / f.h);
      const w = f.w * sc, h = f.h * sc;
      doc.image(f.jpeg, f.w, f.h, 36 + (maxW - w) / 2, 66, w, h);
    }

    function summary(y) {
      if (y === null) { header(chunks.length + 1, true); y = TOP; }
      const x1 = L, x2 = 300, x3 = 440, x4 = R;
      doc.rect(L, y - 12, R - L, 18, { fill: 0.9 });
      doc.text(L + 6, y + 1, 'Abschluss ' + period, { size: 10, bold: true });
      y += 22;
      const kv = function (label, val, bold) {
        doc.text(x1 + 6, y, label, { size: 9, bold: bold });
        doc.text(x2, y, val, { size: 9, bold: bold, align: 'right' });
        y += 14;
      };
      const yTop = y;
      kv(month ? 'Anfangsbestand (Übertrag)' : 'Anfangsbestand', money(opening) + ' €');
      kv('+ Einnahmen', money(sumEin) + ' €');
      kv('− Ausgaben', money(sumAus) + ' €');
      doc.line(x1 + 6, y - 9, x2, y - 9, { width: 0.6 });
      kv('= Endbestand (Soll)', money(bal) + ' €', true);

      // USt- und Vorsteuer-Übersicht
      let yy = yTop;
      const table = function (title, t, colLabel) {
        doc.text(x3, yy, title, { size: 9, bold: true }); yy += 14;
        doc.text(x3, yy, 'Satz', { size: 8, gray: 0.35 });
        doc.text(x3 + 150, yy, colLabel, { size: 8, gray: 0.35, align: 'right' });
        doc.text(x3 + 230, yy, 'Netto', { size: 8, gray: 0.35, align: 'right' });
        doc.text(x4 - 4, yy, title.indexOf('Vorsteuer') === 0 ? 'VSt' : 'USt', { size: 8, gray: 0.35, align: 'right' });
        yy += 12;
        [19, 7, 0].forEach(function (s) {
          doc.text(x3, yy, s + ' %', { size: 9 });
          doc.text(x3 + 150, yy, money(t[s].brutto), { size: 9, align: 'right' });
          doc.text(x3 + 230, yy, money(t[s].brutto - t[s].ust), { size: 9, align: 'right' });
          doc.text(x4 - 4, yy, money(t[s].ust), { size: 9, align: 'right' });
          yy += 13;
        });
        doc.line(x3, yy - 9, x4, yy - 9, { width: 0.6 });
        const tb = t[19].brutto + t[7].brutto + t[0].brutto, tu = t[19].ust + t[7].ust;
        doc.text(x3, yy, 'Summe', { size: 9, bold: true });
        doc.text(x3 + 150, yy, money(tb), { size: 9, bold: true, align: 'right' });
        doc.text(x3 + 230, yy, money(tb - tu), { size: 9, bold: true, align: 'right' });
        doc.text(x4 - 4, yy, money(tu), { size: 9, bold: true, align: 'right' });
        yy += 20;
      };
      table('Umsatzsteuer aus Kassenabrechnungen und Einnahmen', u, 'Umsatz brutto');
      table('Vorsteuer aus bar bezahlten Ausgaben', v, 'Ausgabe brutto');
      yy -= 20;

      // Kassensturz und Unterschrift
      y = Math.max(y, yy) + 26;
      doc.text(x1 + 6, y, 'Kassenbestand gezählt (Ist):', { size: 9 });
      doc.line(x1 + 140, y + 2, x1 + 260, y + 2, { width: 0.5 });
      doc.text(x1 + 280, y, 'Differenz:', { size: 9 });
      doc.line(x1 + 330, y + 2, x1 + 430, y + 2, { width: 0.5 });
      doc.line(x3 + 60, y + 2, x4 - 4, y + 2, { width: 0.5 });
      doc.text(x3 + 60, y + 13, 'Datum, Unterschrift', { size: 7.5, gray: 0.4 });
      if (summaryOwnPage) footer();
    }

    return { bytes: doc.bytes(), pages: total, count: rows.length, endbestand: bal };
  }

  const api = { build: build };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KassenbuchPdf = api;
})(this);
