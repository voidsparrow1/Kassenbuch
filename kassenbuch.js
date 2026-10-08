/* Buchungslogik: aus Einträgen Kassenbuch-Zeilen, Kassenbestand und Excel-Tabelle machen.
   Alle Beträge in Cent. Läuft im Browser (window.Kassenbuch) und in Node (Tests). */
(function (root) {
  'use strict';

  // Felder eines Tagesabschlusses. sign +1 = Einnahme, −1 = wird abgezogen (Ausgabe-Spalte)
  const ZBON = [
    { key: 'u19', label: 'Umsatz 19 %', text: 'Kassenabrechnung Umsatz 19 %', sign: 1, satz: 19 },
    { key: 'u7', label: 'Umsatz 7 %', text: 'Kassenabrechnung Umsatz 7 %', sign: 1, satz: 7 },
    { key: 'u0', label: 'Gutscheinverkauf 0 %', text: 'Gutscheinverkauf 0 %', sign: 1, satz: 0 },
    { key: 'ec', label: 'EC-/Kartenzahlungen', text: 'EC-/Kartenzahlungen (unbar)', sign: -1 },
    { key: 'gutschein', label: 'Gutscheine eingelöst', text: 'Gutscheine eingelöst', sign: -1 },
    { key: 'aus', label: 'Auszahlungen / Ausgaben', text: 'Auszahlungen laut Kassenabrechnung', sign: -1, extra: true },
    { key: 'ein', label: 'Einzahlungen / Einlagen', text: 'Einzahlungen laut Kassenabrechnung', sign: 1, extra: true },
    { key: 'abl', label: 'Ablieferung (Bank/Tresor)', text: 'Ablieferung laut Kassenabrechnung', sign: -1, extra: true }
  ];
  const TYP_ORDER = { zbon: 0, einnahme: 1, ausgabe: 2, storno: 3, zaehlung: 4 };
  const TYP_NAME = { zbon: 'Kassenabrechnung', einnahme: 'Einnahme', ausgabe: 'Ausgabe', storno: 'Storno', zaehlung: 'Kassensturz' };

  // Alte Einträge (vor dem Umbau) waren Einkaufsbelege → Ausgabe
  function normalize(e) {
    if (!e.typ) {
      e.typ = 'ausgabe';
      if (!e.text) e.text = e.haendler || '';
    }
    return e;
  }

  function ust(brutto, satz) { return satz ? Math.round(brutto * satz / (100 + satz)) : 0; }
  const pad = function (v, n) { return String(v).padStart(n || 2, '0'); };
  function belegNr(e) { return e && e.nr ? pad(e.nr, 4) : ''; }
  const deDate = function (iso) { return iso ? iso.split('-').reverse().join('.') : ''; };
  const eurTxt = function (c) {
    const neg = c < 0; c = Math.abs(Math.round(c || 0));
    return (neg ? '−' : '') + Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + pad(c % 100) + ' €';
  };

  // Buchungszeilen eines Eintrags: {datum, text, ein, aus, satz, ust}
  // Storno: die Zeilen des Originals mit umgekehrtem Vorzeichen (Gegenbuchung, gleiche Spalte)
  function lines(e) {
    if (e.typ === 'storno') {
      const orig = Object.assign({}, e.orig || {}, { datum: e.datum });
      return lines(orig).map(function (l) {
        return { datum: e.datum, text: 'Storno Beleg ' + pad(e.ref, 4) + ': ' + l.text, ein: 0 - l.ein || 0, aus: 0 - l.aus || 0, satz: l.satz, ust: 0 - l.ust || 0, storno: true };
      });
    }
    if (e.typ === 'zaehlung') {
      return [{ datum: e.datum, text: 'Kassensturz: gezählt ' + eurTxt(e.ist) + ' (Soll ' + eurTxt(e.soll) + ')', ein: 0, aus: 0, satz: null, ust: 0, info: true }];
    }
    if (e.typ === 'zbon') {
      const out = [];
      for (const f of ZBON) {
        const v = e[f.key] || 0;
        if (!v) continue;
        if (f.sign > 0) out.push({ datum: e.datum, text: f.text, ein: v, aus: 0, satz: f.extra ? null : f.satz, ust: f.extra ? 0 : ust(v, f.satz) });
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
        (TYP_ORDER[a.typ] - TYP_ORDER[b.typ]) || ((a.nr || a.id || 0) - (b.nr || b.id || 0));
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

  // Kassenbestand je Tagesende (Reihenfolge innerhalb eines Tages ist künstlich, daher zählt das Tagesende)
  function dayBalances(entries, start) {
    const out = [];
    for (const r of withBalance(entries, start)) {
      const d = r.e.datum || '';
      if (out.length && out[out.length - 1].datum === d) out[out.length - 1].bestand = r.bestand;
      else out.push({ datum: d, bestand: r.bestand });
    }
    return out;
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

  // ---------- Unveränderbarkeit: fortlaufende Nummern, Prüfsummen-Kette, Storno ----------
  // Felder, die in die Prüfsumme eingehen (Reihenfolge nie ändern – sonst passen alte Prüfsummen nicht mehr)
  const HASH_KEYS = ['nr', 'typ', 'datum', 'text', 'u19', 'u7', 'u0', 'ec', 'gutschein', 'aus', 'ein', 'abl', 'betrag',
    'ist', 'soll', 'ref', 'grund', 'orig', 'korrektur_von', 'nachtraeglich', 'erfasst', 'fotoHash', 'prev'];
  const ORIG_KEYS = ['typ', 'datum', 'text', 'u19', 'u7', 'u0', 'ec', 'gutschein', 'aus', 'ein', 'abl', 'betrag'];

  function canonical(e) {
    return JSON.stringify(HASH_KEYS.map(function (k) {
      const v = e[k];
      if (v === undefined || v === null || v === '') return null;
      if (k === 'orig') return ORIG_KEYS.map(function (ok) { return v[ok] === undefined || v[ok] === '' ? null : v[ok]; });
      return v;
    }));
  }

  // sha: async (string) → Hex-Prüfsumme (SHA-256), im Browser crypto.subtle, in Node webcrypto
  async function seal(e, prevHash, sha) {
    e.prev = prevHash || 'START';
    e.hash = await sha(canonical(e));
    return e;
  }

  async function verifyChain(entries, sha) {
    const list = entries.slice().sort(function (a, b) { return a.nr - b.nr; });
    let prev = 'START';
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.nr !== i + 1) return { ok: false, at: e.nr || null, grund: 'Belegnummer ' + (i + 1) + ' fehlt' };
      if (e.prev !== prev) return { ok: false, at: e.nr, grund: 'Verkettung unterbrochen' };
      if ((await sha(canonical(e))) !== e.hash) return { ok: false, at: e.nr, grund: 'Inhalt verändert' };
      prev = e.hash;
    }
    return { ok: true, last: prev, count: list.length };
  }

  function nextNr(entries) { return entries.reduce(function (m, e) { return Math.max(m, e.nr || 0); }, 0) + 1; }
  function lastHash(entries) {
    let best = null;
    for (const e of entries) if (!best || e.nr > best.nr) best = e;
    return best ? best.hash : 'START';
  }

  // Storno-Buchung zu einem Eintrag. Datum: wie das Original, außer dessen Monat ist bereits festgeschrieben.
  function makeStorno(orig, grund, closedUntil, today) {
    const open = !closedUntil || (orig.datum || '').slice(0, 7) > closedUntil;
    const o = {};
    for (const k of ORIG_KEYS) if (orig[k] !== undefined && orig[k] !== null) o[k] = orig[k];
    return { typ: 'storno', datum: open ? orig.datum : today, ref: orig.nr, grund: grund, orig: o };
  }

  // Welche Einträge sind storniert? → { nr: Storno-Eintrag }
  function stornoMap(entries) {
    const m = {};
    for (const e of entries) if (e.typ === 'storno') m[e.ref] = e;
    return m;
  }

  // ---------- Festschreibung und Datumsprüfung ----------
  // closed: { '2026-08': { am, hash, bisNr } } → letzter festgeschriebener Monat oder null
  function closedUntil(closed) {
    const ks = Object.keys(closed || {}).sort();
    return ks.length ? ks[ks.length - 1] : null;
  }
  function checkDate(datum, closed, today) {
    if (!datum) return 'Bitte Datum wählen';
    if (datum > today) return 'Datum liegt in der Zukunft';
    const cu = closedUntil(closed);
    if (cu && datum.slice(0, 7) <= cu) return monthLabel(cu) + ' ist abgeschlossen. Bitte mit heutigem Datum buchen.';
    return null;
  }
  // Monate, die festgeschrieben werden können: vergangen, noch offen, ab Anfangsbestand
  function closableMonths(entries, start, closed, today) {
    const cur = today.slice(0, 7), cu = closedUntil(closed);
    const first = (start && start.datum ? start.datum : today).slice(0, 7);
    const out = [];
    let m = first;
    while (m < cur) {
      if (!cu || m > cu) out.push(m);
      const p = m.split('-').map(Number);
      m = p[1] === 12 ? (p[0] + 1) + '-01' : p[0] + '-' + pad(p[1] + 1);
    }
    return out;
  }
  function daysBetween(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000); }

  // Kassenbestand am Ende eines Tages (für den Kassensturz)
  function balanceAt(entries, start, datum) {
    let bal = start ? start.betrag || 0 : 0;
    for (const e of entries) if ((e.datum || '') <= datum) bal += net(e);
    return bal;
  }

  function months(entries) {
    const set = {};
    for (const e of entries) if (e.datum) set[e.datum.slice(0, 7)] = true;
    return Object.keys(set).sort().reverse();
  }

  const api = { ZBON: ZBON, TYP_NAME: TYP_NAME, normalize: normalize, lines: lines, net: net, sortEntries: sortEntries, withBalance: withBalance,
    buildSheet: buildSheet, months: months, monthLabel: monthLabel, ust: ust, belegNr: belegNr, deDate: deDate,
    canonical: canonical, seal: seal, verifyChain: verifyChain, nextNr: nextNr, lastHash: lastHash,
    makeStorno: makeStorno, stornoMap: stornoMap, closedUntil: closedUntil, checkDate: checkDate,
    closableMonths: closableMonths, daysBetween: daysBetween, balanceAt: balanceAt, dayBalances: dayBalances };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Kassenbuch = api;
})(this);
