/* Fertiges Kassenbuch als PDF (A4 quer): Kopf, lfd. Nr., Beleg, Übertrag, Seitensummen,
   Monatsabschluss mit USt-Übersicht und Unterschriftsfeld. Braucht Kassenbuch (kassenbuch.js) und PdfLite (pdf.js). */
(function (root) {
  'use strict';
  const K = root.Kassenbuch || (typeof require !== 'undefined' ? require('./kassenbuch.js') : null);
  const PdfLite = root.PdfLite || (typeof require !== 'undefined' ? require('./pdf.js') : null);

  const pad = function (v) { return String(v).padStart(2, '0'); };
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
    text: { x: 168, w: 262, title: 'Buchungstext' },
    ein: { x: 512, align: 'right', title: 'Einnahme €' },
    aus: { x: 590, align: 'right', title: 'Ausgabe €' },
    satz: { x: 632, align: 'right', title: 'USt %' },
    ust: { x: 700, align: 'right', title: 'USt €' },
    bestand: { x: R - 4, align: 'right', title: 'Bestand €' }
  };
  const ROW = 15, TOP = 112, BOTTOM = 540;

  /* entries/start wie in der App; month '2026-10' oder null (alles).
     opts: { firma, erstellt (Date) } → Uint8Array (PDF) */
  function build(entries, start, month, opts) {
    opts = opts || {};
    const sorted = K.sortEntries(entries);
    const from = month ? month + '-01' : null;
    const to = month ? lastDay(month) : null;
    let opening = start ? start.betrag || 0 : 0;
    const rows = [];
    for (const e of sorted) {
      if (from && (e.datum || '') < from) { opening += K.net(e); continue; }
      if (to && (e.datum || '') > to) continue;
      const beleg = e.typ === 'zbon' ? 'KA ' + (e.datum || '').slice(8, 10) + '.' + (e.datum || '').slice(5, 7) + '.' : 'B-' + (e.id || '');
      for (const l of K.lines(e)) rows.push(Object.assign({ beleg: beleg }, l));
    }

    const period = month ? K.monthLabel(month) : 'Gesamtzeitraum';
    const doc = new PdfLite.Doc({ landscape: true, title: 'Kassenbuch ' + period });
    const now = opts.erstellt || new Date();
    const stamp = de(now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());

    // Seiten vorab aufteilen, damit "Seite x von y" stimmt
    const perPage = Math.floor((BOTTOM - TOP - 2 * ROW) / ROW);   // Platz für Übertrag oben + Seitensumme unten
    const SUMMARY_H = 150;
    const chunks = [];
    for (let i = 0; i < rows.length; i += perPage) chunks.push(rows.slice(i, i + perPage));
    if (!chunks.length) chunks.push([]);
    const lastRowsY = TOP + (chunks[chunks.length - 1].length + 2) * ROW;
    const summaryOwnPage = lastRowsY + SUMMARY_H > BOTTOM + 40;
    const total = chunks.length + (summaryOwnPage ? 1 : 0);

    let bal = opening, nr = 0, sumEin = 0, sumAus = 0;
    const u = { 19: { brutto: 0, ust: 0 }, 7: { brutto: 0, ust: 0 }, 0: { brutto: 0, ust: 0 } };

    function header(pageNo) {
      doc.addPage();
      doc.text(L, 46, 'Kassenbuch', { size: 18, bold: true });
      if (opts.firma) doc.text(L + 112, 46, opts.firma, { size: 12, maxWidth: 400 });
      doc.text(R, 40, period, { size: 12, bold: true, align: 'right' });
      doc.text(R, 54, 'Seite ' + pageNo + ' von ' + total, { size: 8.5, align: 'right', gray: 0.35 });
      const z = month ? de(from) + ' – ' + de(to) : '';
      if (z) doc.text(L, 62, 'Zeitraum ' + z, { size: 8.5, gray: 0.35 });
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
        if (r.satz !== null && r.satz !== undefined && u[r.satz]) { u[r.satz].brutto += r.ein; u[r.satz].ust += r.ust; }
        if (i % 2 === 1) doc.rect(L, y - 10.5, R - L, ROW, { fill: 0.965 });
        doc.text(COL.nr.x, y, nr, { size: 8.5, align: 'right', gray: 0.35 });
        doc.text(COL.datum.x, y, de(r.datum), { size: 8.5 });
        doc.text(COL.beleg.x, y, r.beleg, { size: 8.5, maxWidth: 44 });
        doc.text(COL.text.x, y, r.text, { size: 8.5, maxWidth: COL.text.w });
        if (r.ein) doc.text(COL.ein.x, y, money(r.ein), { size: 8.5, align: 'right' });
        if (r.aus) doc.text(COL.aus.x, y, money(r.aus), { size: 8.5, align: 'right' });
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

    function summary(y) {
      if (y === null) { header(total); y = TOP; }
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

      // USt-Übersicht
      let yy = yTop;
      doc.text(x3, yy, 'Umsatzsteuer aus Kassenabrechnungen', { size: 9, bold: true }); yy += 14;
      doc.text(x3, yy, 'Satz', { size: 8, gray: 0.35 });
      doc.text(x3 + 150, yy, 'Umsatz brutto', { size: 8, gray: 0.35, align: 'right' });
      doc.text(x3 + 230, yy, 'Netto', { size: 8, gray: 0.35, align: 'right' });
      doc.text(x4 - 4, yy, 'USt', { size: 8, gray: 0.35, align: 'right' });
      yy += 12;
      [19, 7, 0].forEach(function (s) {
        const b = u[s].brutto, t = u[s].ust;
        doc.text(x3, yy, s + ' %', { size: 9 });
        doc.text(x3 + 150, yy, money(b), { size: 9, align: 'right' });
        doc.text(x3 + 230, yy, money(b - t), { size: 9, align: 'right' });
        doc.text(x4 - 4, yy, money(t), { size: 9, align: 'right' });
        yy += 13;
      });
      doc.line(x3, yy - 9, x4, yy - 9, { width: 0.6 });
      const tb = u[19].brutto + u[7].brutto + u[0].brutto, tu = u[19].ust + u[7].ust;
      doc.text(x3, yy, 'Summe', { size: 9, bold: true });
      doc.text(x3 + 150, yy, money(tb), { size: 9, bold: true, align: 'right' });
      doc.text(x3 + 230, yy, money(tb - tu), { size: 9, bold: true, align: 'right' });
      doc.text(x4 - 4, yy, money(tu), { size: 9, bold: true, align: 'right' });

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
