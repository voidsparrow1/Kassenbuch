/* Buchungslogik: aus Einträgen Kassenbuch-Zeilen, Kassenbestand und Excel-Tabelle machen.
   Alle Beträge in Cent. Läuft im Browser (window.Kassenbuch) und in Node (Tests). */
(function (root) {
  'use strict';

  // Felder eines Tagesabschlusses. sign +1 = Einnahme, −1 = wird abgezogen (Ausgabe-Spalte)
  const ZBON = [
    { key: 'u19', label: 'Umsatz 19 %', text: 'Tagesabschluss Umsatz 19 %', sign: 1, satz: 19 },
    { key: 'u7', label: 'Umsatz 7 %', text: 'Tagesabschluss Umsatz 7 %', sign: 1, satz: 7 },
    { key: 'u0', label: 'Gutscheinverkauf 0 %', text: 'Gutscheinverkauf 0 %', sign: 1, satz: 0 },
    { key: 'ec', label: 'EC-/Kartenzahlungen', text: 'EC-/Kartenzahlungen (unbar)', sign: -1 },
    { key: 'gutschein', label: 'Gutscheine eingelöst', text: 'Gutscheine eingelöst', sign: -1 }
  ];

  const TYP_ORDER = { zbon: 0, einnahme: 1, ausgabe: 2 };

  // Alte Einträge (vor dem Umbau) waren Einkaufsbelege → Ausgabe
  function normalize(e) {
    if (!e.typ) {
      e.typ = 'ausgabe';
      if (!e.text) e.text = e.haendler || '';
    }
    return e;
  }

  function ust(brutto, satz) { return satz ? Math.round(brutto * satz / (100 + satz)) : 0; }

  // Buchungszeilen eines Eintrags: {datum, text, ein, aus, satz, ust}
  function lines(e) {
    if (e.typ === 'zbon') {
      const out = [];
      for (const f of ZBON) {
        const v = e[f.key] || 0;
        if (!v) continue;
        if (f.sign > 0) out.push({ datum: e.datum, text: f.text, ein: v, aus: 0, satz: f.satz, ust: ust(v, f.satz) });
        else out.push({ datum: e.datum, text: f.text, ein: 0, aus: v, satz: null, ust: 0 });
      }
      return out;
    }
    if (e.typ === 'einnahme') return [{ datum: e.datum, text: e.text || 'Einnahme', ein: e.betrag || 0, aus: 0, satz: null, ust: 0 }];
    return [{ datum: e.datum, text: e.text || 'Ausgabe', ein: 0, aus: e.betrag || 0, satz: null, ust: 0 }];
  }

  function net(e) { return lines(e).reduce(function (a, l) { return a + l.ein - l.aus; }, 0); }

  // Pro Tag: erst Einnahmen, dann Ausgaben → kein künstlich negativer Bestand im Tagesverlauf
  function sortEntries(list) {
    return list.slice().sort(function (a, b) {
      return (a.datum || '').localeCompare(b.datum || '') ||
        (TYP_ORDER[a.typ] - TYP_ORDER[b.typ]) || ((a.id || 0) - (b.id || 0));
    });
  }

  // Laufender Kassenbestand nach jedem Eintrag
  function withBalance(entries, start) {
    let bal = start ? start.betrag || 0 : 0;
    return sortEntries(entries).map(function (e) {
      bal += net(e);
      return { e: e, bestand: bal };
    });
  }

  const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  function monthLabel(ym) { const p = ym.split('-'); return MONTHS[+p[1] - 1] + ' ' + p[0]; }
  function lastDay(ym) { const p = ym.split('-').map(Number); return ym + '-' + String(new Date(Date.UTC(p[0], p[1], 0)).getUTCDate()).padStart(2, '0'); }

  /* Excel-Tabelle für einen Monat ('2026-10') oder alles (null).
     Spalten: Datum | Text | Einnahme | Ausgabe | USt-Satz | USt | Kassenbestand */
  function buildSheet(entries, start, month) {
    const sorted = sortEntries(entries);
    const from = month ? month + '-01' : null;
    const to = month ? lastDay(month) : null;
    let opening = start ? start.betrag || 0 : 0;
    const inPeriod = [];
    for (const e of sorted) {
      if (from && (e.datum || '') < from) opening += net(e);
      else if (!to || (e.datum || '') <= to) inPeriod.push(e);
    }
    const eur = function (c) { return Math.round(c) / 100; };
    const title = 'Kassenbuch ' + (month ? monthLabel(month) : 'gesamt');
    const H = 4;                       // erste Datenzeile (Excel-Zeilennummer)
    const rows = [
      [{ v: title, s: 'title' }],
      [],
      [{ v: 'Datum', s: 'header' }, { v: 'Text', s: 'header' }, { v: 'Einnahme', s: 'headerRight' }, { v: 'Ausgabe', s: 'headerRight' },
        { v: 'USt-Satz', s: 'headerRight' }, { v: 'USt', s: 'headerRight' }, { v: 'Kassenbestand', s: 'headerRight' }]
    ];
    const openDate = month ? from : (start && start.datum) || (inPeriod[0] && inPeriod[0].datum) || null;
    rows.push([{ v: openDate, s: 'date' }, { v: month ? 'Übertrag / Anfangsbestand' : 'Anfangsbestand', s: 'bold' }, null, null, null, null,
      { v: eur(opening), s: 'moneyBold' }]);

    let bal = opening, sumEin = 0, sumAus = 0, ust19 = 0, ust7 = 0;
    for (const e of inPeriod) {
      for (const l of lines(e)) {
        const r = rows.length + 1;
        bal += l.ein - l.aus; sumEin += l.ein; sumAus += l.aus;
        if (l.satz === 19) ust19 += l.ust;
        if (l.satz === 7) ust7 += l.ust;
        rows.push([
          { v: l.datum, s: 'date' },
          { v: l.text },
          l.ein ? { v: eur(l.ein), s: 'money' } : null,
          l.aus ? { v: eur(l.aus), s: 'money' } : null,
          l.satz !== null && l.satz !== undefined ? { v: l.satz / 100, s: 'percent' } : null,
          l.satz ? { v: eur(l.ust), s: 'money' } : null,
          { v: eur(bal), s: 'money', f: 'G' + (r - 1) + '+C' + r + '-D' + r }
        ]);
      }
    }
    const last = rows.length;           // letzte Buchungszeile
    rows.push([]);
    rows.push([null, { v: 'Summe', s: 'bold' },
      { v: eur(sumEin), s: 'moneyBold', f: 'SUM(C' + (H + 1) + ':C' + Math.max(H + 1, last) + ')' },
      { v: eur(sumAus), s: 'moneyBold', f: 'SUM(D' + (H + 1) + ':D' + Math.max(H + 1, last) + ')' },
      null,
      { v: eur(ust19 + ust7), s: 'moneyBold', f: 'SUM(F' + (H + 1) + ':F' + Math.max(H + 1, last) + ')' },
      { v: eur(bal), s: 'moneyBold', f: 'G' + last }]);
    rows.push([null, { v: 'davon USt 19 %' }, null, null, null,
      { v: eur(ust19), s: 'money', f: 'SUMIF(E' + (H + 1) + ':E' + Math.max(H + 1, last) + ',0.19,F' + (H + 1) + ':F' + Math.max(H + 1, last) + ')' }]);
    rows.push([null, { v: 'davon USt 7 %' }, null, null, null,
      { v: eur(ust7), s: 'money', f: 'SUMIF(E' + (H + 1) + ':E' + Math.max(H + 1, last) + ',0.07,F' + (H + 1) + ':F' + Math.max(H + 1, last) + ')' }]);

    return {
      sheet: { name: month ? monthLabel(month) : 'Kassenbuch', widths: [12, 34, 13, 13, 10, 12, 15], freezeRows: 3, rows: rows },
      title: title, count: inPeriod.length, endbestand: bal
    };
  }

  function months(entries) {
    const set = {};
    for (const e of entries) if (e.datum) set[e.datum.slice(0, 7)] = true;
    return Object.keys(set).sort().reverse();
  }

  const api = { ZBON: ZBON, normalize: normalize, lines: lines, net: net, sortEntries: sortEntries, withBalance: withBalance,
    buildSheet: buildSheet, months: months, monthLabel: monthLabel, ust: ust };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Kassenbuch = api;
})(this);
