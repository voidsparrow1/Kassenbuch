/* Buchungslogik: aus Einträgen Kassenbuch-Zeilen, Kassenbestand und Excel-Tabelle machen.
   Alle Beträge in Cent. Läuft im Browser (window.Kassenbuch) und in Node (Tests). */
(function (root) {
  'use strict';

  // Felder eines Tagesabschlusses. sign +1 = Einnahme, −1 = wird abgezogen (Ausgabe-Spalte)
  const ZBON = [
    { key: 'u19', label: 'Umsatz 19 %', text: 'Kassenabrechnung Umsatz 19 %', sign: 1, satz: 19, art: 'Erlöse' },
    { key: 'u7', label: 'Umsatz 7 %', text: 'Kassenabrechnung Umsatz 7 %', sign: 1, satz: 7, art: 'Erlöse' },
    { key: 'u0', label: 'Gutscheinverkauf 0 %', text: 'Gutscheinverkauf 0 %', sign: 1, satz: 0, art: 'Gutschein' },
    { key: 'ec', label: 'EC-/Kartenzahlungen', text: 'Geldtransit EC-/Kartenzahlungen (unbar)', sign: -1, art: 'Geldtransit EC' },
    { key: 'gutschein', label: 'Gutscheine eingelöst', text: 'Gutscheine eingelöst (unbar)', sign: -1, art: 'Gutschein' },
    { key: 'aus', label: 'Auszahlungen / Ausgaben', text: 'Auszahlungen laut Kassenabrechnung', sign: -1, extra: true, art: 'Auszahlung' },
    { key: 'ein', label: 'Einzahlungen / Einlagen', text: 'Einzahlungen laut Kassenabrechnung', sign: 1, extra: true, art: 'Einzahlung' },
    { key: 'abl', label: 'Ablieferung (Bank/Tresor)', text: 'Ablieferung laut Kassenabrechnung', sign: -1, extra: true, art: 'Geldtransit' }
  ];

  // Art der Buchung (ohne Kontonummern). vst: Steuersatz/Vorsteuer wird abgefragt
  const ARTEN = {
    ausgabe: [
      { key: 'ware', label: 'Wareneinkauf', kurz: 'Ware', vst: true },
      { key: 'betrieb', label: 'Sonstige Betriebsausgabe', kurz: 'Betriebsausg.', vst: true },
      { key: 'transit_bank', label: 'Geldtransit zur Bank (Einzahlung aufs Konto)', kurz: 'Geldtransit' },
      { key: 'privat_ent', label: 'Privatentnahme', kurz: 'Privat' }
    ],
    einnahme: [
      { key: 'transit_kasse', label: 'Geldtransit von der Bank (z. B. Wechselgeld)', kurz: 'Geldtransit' },
      { key: 'privat_ein', label: 'Privateinlage', kurz: 'Privat' },
      { key: 'sonst', label: 'Sonstige Einnahme', kurz: 'Sonstige', vst: true }
    ]
  };
  const ART_EXTRA = { kassendiff: { key: 'kassendiff', label: 'Kassendifferenz', kurz: 'Kassendiff.' } };
  function artInfo(typ, key) {
    if (ART_EXTRA[key]) return ART_EXTRA[key];
    return (ARTEN[typ] || []).find(function (a) { return a.key === key; }) || null;
  }

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

  // Buchungszeilen eines Eintrags: {datum, text, art, ein, aus, satz, ust, vst}
  //  vst = true: Vorsteuer aus einer Ausgabe (statt Umsatzsteuer)
  // Storno: die Zeilen des Originals mit umgekehrtem Vorzeichen (Gegenbuchung, gleiche Spalte)
  function lines(e) {
    if (e.typ === 'storno') {
      const orig = Object.assign({}, e.orig || {}, { datum: e.datum });
      return lines(orig).map(function (l) {
        return { datum: e.datum, text: 'Storno Beleg ' + pad(e.ref, 4) + ': ' + l.text, art: l.art, ein: 0 - l.ein || 0, aus: 0 - l.aus || 0,
          satz: l.satz, ust: 0 - l.ust || 0, vst: l.vst, storno: true };
      });
    }
    if (e.typ === 'zaehlung') {
      return [{ datum: e.datum, text: 'Kassensturz: gezählt ' + eurTxt(e.ist) + ' (Soll ' + eurTxt(e.soll) + ')', art: 'Kassensturz', ein: 0, aus: 0, satz: null, ust: 0, info: true }];
    }
    if (e.typ === 'zbon') {
      const out = [];
      const z = e.znr ? ' #' + e.znr : '';
      for (const f of ZBON) {
        const v = e[f.key] || 0;
        if (!v) continue;
        const text = /^Kassenabrechnung/.test(f.text) ? f.text.replace('Kassenabrechnung', 'Kassenabrechnung' + z) : f.text + (z ? ' (' + z.trim() + ')' : '');
        if (f.sign > 0) out.push({ datum: e.datum, text: text, art: f.art, ein: v, aus: 0, satz: f.extra ? null : f.satz, ust: f.extra ? 0 : ust(v, f.satz) });
        else out.push({ datum: e.datum, text: text, art: f.art, ein: 0, aus: v, satz: null, ust: 0 });
      }
      return out;
    }
    // Einnahme / Ausgabe – mit Art und ggf. Steuersatz (auch aufgeteilt 19 % / 7 %)
    const isEin = e.typ === 'einnahme';
    const a = artInfo(e.typ, e.art);
    const art = a ? a.kurz : (isEin ? 'Einnahme' : 'Ausgabe');
    const text = (e.text || (isEin ? 'Einnahme' : 'Ausgabe')) + (e.eigenbeleg ? ' (Eigenbeleg)' : '');
    const mk = function (betrag, satz, suffix) {
      const s = satz === null || satz === undefined || satz === '' ? null : +satz;
      return { datum: e.datum, text: text + (suffix || ''), art: art, ein: isEin ? betrag : 0, aus: isEin ? 0 : betrag,
        satz: s, ust: s ? ust(betrag, s) : 0, vst: !isEin && s !== null };
    };
    if (e.satz === 'mix') {
      const b19 = e.b19 || 0, b7 = e.b7 || 0, rest = (e.betrag || 0) - b19 - b7;
      const out = [];
      if (b19) out.push(mk(b19, 19, ' (19 %)'));
      if (b7) out.push(mk(b7, 7, ' (7 %)'));
      if (rest) out.push(mk(rest, 0, ' (0 %)'));
      return out;
    }
    return [mk(e.betrag || 0, e.satz)];
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
     Spalten: Datum | Beleg | Art | Buchungstext | Einnahme | Ausgabe | Steuersatz | USt/VSt | Kassenbestand */
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
    const hdr = function (v, right) { return { v: v, s: right ? 'headerRight' : 'header' }; };
    const rows = [
      [{ v: title, s: 'title' }],
      [],
      [hdr('Datum'), hdr('Beleg'), hdr('Art'), hdr('Buchungstext'), hdr('Einnahme', 1), hdr('Ausgabe', 1), hdr('Steuersatz', 1), hdr('USt/VSt', 1), hdr('Kassenbestand', 1)]
    ];
    const openDate = month ? from : (start && start.datum) || (inPeriod[0] && inPeriod[0].datum) || null;
    rows.push([{ v: openDate, s: 'date' }, null, null, { v: month ? 'Übertrag / Anfangsbestand' : 'Anfangsbestand', s: 'bold' }, null, null, null, null,
      { v: eur(opening), s: 'moneyBold' }]);

    let bal = opening, sumEin = 0, sumAus = 0;
    const tax = { u19: 0, u7: 0, v19: 0, v7: 0 };
    for (const e of inPeriod) {
      for (const l of lines(e)) {
        const r = rows.length + 1;
        bal += l.ein - l.aus; sumEin += l.ein; sumAus += l.aus;
        if (l.satz === 19 || l.satz === 7) tax[(l.vst ? 'v' : 'u') + l.satz] += l.ust;
        rows.push([
          { v: l.datum, s: 'date' },
          { v: belegNr(e) },
          { v: l.art || '' },
          { v: l.text },
          l.ein ? { v: eur(l.ein), s: 'money' } : null,
          l.aus ? { v: eur(l.aus), s: 'money' } : null,
          l.satz !== null && l.satz !== undefined ? { v: l.satz / 100, s: 'percent' } : null,
          l.satz ? { v: eur(l.ust), s: 'money' } : null,
          { v: eur(bal), s: 'money', f: 'I' + (r - 1) + '+E' + r + '-F' + r }
        ]);
      }
    }
    const lastRow = rows.length;                 // letzte Buchungszeile (oder Übertrag, wenn keine Buchung)
    const last = Math.max(H + 1, lastRow);
    const rg = function (c) { return c + (H + 1) + ':' + c + last; };
    rows.push([]);
    rows.push([null, null, null, { v: 'Summe', s: 'bold' },
      { v: eur(sumEin), s: 'moneyBold', f: 'SUM(' + rg('E') + ')' },
      { v: eur(sumAus), s: 'moneyBold', f: 'SUM(' + rg('F') + ')' },
      null, null,
      { v: eur(bal), s: 'moneyBold', f: 'I' + lastRow }]);
    const taxRow = function (label, val, rate, col) {
      rows.push([null, null, null, { v: label }, null, null, null,
        { v: eur(val), s: 'money', f: 'SUMIFS(' + rg('H') + ',' + rg('G') + ',' + rate + ',' + rg(col) + ',"<>")' }]);
    };
    taxRow('Umsatzsteuer 19 % (aus Einnahmen)', tax.u19, '0.19', 'E');
    taxRow('Umsatzsteuer 7 % (aus Einnahmen)', tax.u7, '0.07', 'E');
    taxRow('Vorsteuer 19 % (aus Ausgaben)', tax.v19, '0.19', 'F');
    taxRow('Vorsteuer 7 % (aus Ausgaben)', tax.v7, '0.07', 'F');

    return {
      sheet: { name: month ? monthLabel(month) : 'Kassenbuch', widths: [11, 7, 14, 40, 12, 12, 10, 11, 14], freezeRows: 3, rows: rows },
      title: title, count: inPeriod.length, endbestand: bal
    };
  }

  // ---------- Unveränderbarkeit: fortlaufende Nummern, Prüfsummen-Kette, Storno ----------
  // Felder, die in die Prüfsumme eingehen (Reihenfolge nie ändern – sonst passen alte Prüfsummen nicht mehr)
  // Version 1 (bis App-Version 13) – für bestehende Buchungen unverändert weiterverwenden
  const HASH_KEYS = ['nr', 'typ', 'datum', 'text', 'u19', 'u7', 'u0', 'ec', 'gutschein', 'aus', 'ein', 'abl', 'betrag',
    'ist', 'soll', 'ref', 'grund', 'orig', 'korrektur_von', 'nachtraeglich', 'erfasst', 'fotoHash', 'prev'];
  const ORIG_KEYS = ['typ', 'datum', 'text', 'u19', 'u7', 'u0', 'ec', 'gutschein', 'aus', 'ein', 'abl', 'betrag'];
  // Version 2: zusätzlich Art, Steuersatz, Abrechnungs-Nr., Eigenbeleg, Kassenführer
  const NEW_KEYS = ['art', 'satz', 'b19', 'b7', 'znr', 'eigenbeleg', 'empfaenger', 'ohnegrund', 'kassierer'];
  const HASH_KEYS_V2 = HASH_KEYS.concat(['hv']).concat(NEW_KEYS);
  const ORIG_KEYS_V2 = ORIG_KEYS.concat(['art', 'satz', 'b19', 'b7', 'znr', 'eigenbeleg', 'empfaenger']);
  const HASH_VERSION = 2;

  function canonical(e) {
    const v2 = (e.hv || 1) >= 2;
    const keys = v2 ? HASH_KEYS_V2 : HASH_KEYS, okeys = v2 ? ORIG_KEYS_V2 : ORIG_KEYS;
    return JSON.stringify(keys.map(function (k) {
      const v = e[k];
      if (v === undefined || v === null || v === '') return null;
      if (k === 'orig') return okeys.map(function (ok) { return v[ok] === undefined || v[ok] === '' ? null : v[ok]; });
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
    for (const k of ORIG_KEYS_V2) if (orig[k] !== undefined && orig[k] !== null && orig[k] !== '') o[k] = orig[k];
    return { typ: 'storno', datum: open ? orig.datum : today, ref: orig.nr, grund: grund, orig: o };
  }

  // Welche Einträge sind storniert? → { nr: Storno-Eintrag }
  function stornoMap(entries) {
    const m = {};
    for (const e of entries) if (e.typ === 'storno') m[e.ref] = e;
    return m;
  }

  // ---------- Fortlaufende Nummer der Kassenabrechnung (#340, #341 …) ----------
  // → { doppelt: Eintrag | null, luecke: [von, bis] | null, letzte: Nummer | null }
  function znrCheck(entries, znr) {
    const sm = stornoMap(entries);
    const z = entries.filter(function (e) { return e.typ === 'zbon' && e.znr && !sm[e.nr]; });
    const res = { doppelt: null, luecke: null, letzte: null };
    if (!z.length || !znr) return res;
    res.doppelt = z.find(function (e) { return +e.znr === +znr; }) || null;
    const max = Math.max.apply(null, z.map(function (e) { return +e.znr; }));
    res.letzte = max;
    if (+znr > max + 1) res.luecke = [max + 1, +znr - 1];
    return res;
  }
  // Alle Lücken in der Nummernfolge (für das Belegverzeichnis)
  function znrGaps(entries) {
    const sm = stornoMap(entries);
    const nums = entries.filter(function (e) { return e.typ === 'zbon' && e.znr && !sm[e.nr]; }).map(function (e) { return +e.znr; }).sort(function (a, b) { return a - b; });
    const gaps = [];
    for (let i = 1; i < nums.length; i++) if (nums[i] > nums[i - 1] + 1) gaps.push([nums[i - 1] + 1, nums[i] - 1]);
    return gaps;
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

  const api = { ZBON: ZBON, ARTEN: ARTEN, artInfo: artInfo, HASH_VERSION: HASH_VERSION, znrCheck: znrCheck, znrGaps: znrGaps, TYP_NAME: TYP_NAME, normalize: normalize, lines: lines, net: net, sortEntries: sortEntries, withBalance: withBalance,
    buildSheet: buildSheet, months: months, monthLabel: monthLabel, ust: ust, belegNr: belegNr, deDate: deDate,
    canonical: canonical, seal: seal, verifyChain: verifyChain, nextNr: nextNr, lastHash: lastHash,
    makeStorno: makeStorno, stornoMap: stornoMap, closedUntil: closedUntil, checkDate: checkDate,
    closableMonths: closableMonths, daysBetween: daysBetween, balanceAt: balanceAt, dayBalances: dayBalances };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Kassenbuch = api;
})(this);
