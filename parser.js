/* Liest Datum, Händler und Betrag aus einem Kassenbon.
   Zwei Quellen: TSE-QR-Code (exakt) und OCR-Text (Fallback).
   Läuft im Browser (window.BonParser) und in Node (für Tests). */
(function (root) {
  'use strict';

  // ---------- Hilfsfunktionen ----------
  function pad(n) { return String(n).padStart(2, '0'); }

  function isoDate(y, m, d) {
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return null; // z. B. 31.02.
    return y + '-' + pad(m) + '-' + pad(d);
  }

  // "12,34" / "12.34" / "1.234,56" / "12 ,34" → Cent als Ganzzahl
  function toCents(str) {
    let s = String(str).replace(/\s/g, '').replace(/[€EUR]/gi, '');
    const neg = /^-|-$/.test(s);
    s = s.replace(/-/g, '');
    const m = s.match(/^(\d{1,3}(?:[.,]\d{3})*|\d+)[.,](\d{2})$/);
    if (!m) return null;
    const euros = parseInt(m[1].replace(/[.,]/g, ''), 10);
    const cents = euros * 100 + parseInt(m[2], 10);
    return neg ? -cents : cents;
  }

  // Alle Beträge in einer Zeile (OCR liest Komma oft als Punkt oder mit Leerzeichen)
  const AMOUNT_RE = /-?\d{1,3}(?:\.\d{3})*\s?[.,]\s?\d{2}(?!\d)|-?\d+\s?[.,]\s?\d{2}(?!\d)/g;
  function amountsIn(line) {
    const out = [];
    const found = line.match(AMOUNT_RE) || [];
    for (const f of found) {
      const c = toCents(f);
      if (c !== null) out.push(c);
    }
    return out;
  }

  // ---------- TSE-QR-Code (KassenSichV / DSFinV-K) ----------
  // Aufbau: V0;Kasse;Kassenbeleg-V1;Beleg^b19_b7_b10,7_b5,5_b0^Betrag:Art_...;TA-Nr;Zähler;Start;Ende;...
  function parseTseQr(text) {
    if (!text || !/^V0;/.test(text)) return null;
    const f = text.split(';');
    if (f.length < 8) return null;
    const process = f[3] || '';
    const parts = process.split('^');
    if (parts.length < 2) return null;

    const brutto = parts[1].split('_').map(function (v) { return Math.round(parseFloat(v) * 100) || 0; });
    let total = brutto.reduce(function (a, b) { return a + b; }, 0);

    // Zahlungen ("10.00:Bar_5.00:Unbar") als Gegenprobe
    let zahlungsart = null;
    if (parts[2]) {
      const pays = parts[2].split('_').map(function (p) {
        const q = p.split(':');
        return { cents: Math.round(parseFloat(q[0]) * 100) || 0, art: (q[1] || '').toLowerCase() };
      });
      const bar = pays.some(function (p) { return p.art === 'bar'; });
      const unbar = pays.some(function (p) { return p.art === 'unbar'; });
      zahlungsart = bar && unbar ? 'Gemischt' : bar ? 'Bar' : unbar ? 'Karte' : null;
      if (!total) total = pays.reduce(function (a, p) { return a + p.cents; }, 0);
    }

    let datum = null;
    const ts = f[7] || f[6];
    if (ts) {
      let d = /^\d{9,11}$/.test(ts) ? new Date(parseInt(ts, 10) * 1000) : new Date(ts);
      if (!isNaN(d)) {
        // in lokaler Zeit des Geräts (Deutschland)
        datum = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      }
    }

    return {
      datum: datum,
      betrag: total || null,
      mwst: { satz19: brutto[0] || 0, satz7: brutto[1] || 0 },
      zahlungsart: zahlungsart
    };
  }

  // ---------- OCR-Text ----------
  const SKIP_MERCHANT = /willkommen|kassenbon|kassenbeleg|quittung|rechnung|beleg|filiale|tel\.?|telefon|www\.|http|ust|steuer|str(\.|aße|asse)|\d{5}\s/i;

  function findMerchant(lines) {
    for (let i = 0; i < Math.min(lines.length, 8); i++) {
      const raw = lines[i];
      const letters = (raw.match(/[A-Za-zÄÖÜäöüß]/g) || []).length;
      if (letters < 3) continue;
      if (letters / raw.replace(/\s/g, '').length < 0.6) continue; // viel Müll
      if (SKIP_MERCHANT.test(raw)) continue;
      return raw.replace(/^[^A-Za-zÄÖÜäöüß0-9]+|[^A-Za-zÄÖÜäöüß0-9.)]+$/g, '').replace(/\s{2,}/g, ' ').trim();
    }
    return null;
  }

  // Nur Daten aus den letzten 2 Jahren bis heute gelten als plausibel.
  // Bewertung je Kandidat: Datum steht allein in der Zeile (+3), direkt bei "Umsatz gelöscht" (+3),
  // kommt mehrfach vor (+2 je Wiederholung). Bei Gleichstand gewinnt das neuere Datum.
  // Zeilen wie "C 13.08.2026 12:00" (Beginn des Abrechnungszeitraums) zählen weniger.
  function findDate(text, now) {
    const today = now || new Date();
    const todayIso = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
    const minIso = (today.getFullYear() - 2) + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
    const ok = function (d) { return d && d >= minIso && d <= todayIso; };
    const lines = String(text || '').split(/\r?\n/);
    const cand = {};
    const DATE_RE = /(?:^|[^\d])(\d{1,2})\s?[.\/-]\s?(\d{1,2})\s?[.\/-]\s?(\d{4}|\d{2})(?!\d)/g;
    lines.forEach(function (line, i) {
      const near = /gel[öo]scht|abschluss\s*vom|datum/i.test(line) || (i > 0 && /gel[öo]scht/i.test(lines[i - 1]));
      const rest = line.replace(DATE_RE, ' ').replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ').replace(/[\s|.,:;'"`_\-]/g, '');
      const alone = rest.length <= 3;
      const period = /^\W*[cC]\s/.test(line);
      let m;
      DATE_RE.lastIndex = 0;
      while ((m = DATE_RE.exec(line))) {
        const d = isoDate(parseInt(m[3], 10), parseInt(m[2], 10), parseInt(m[1], 10));
        DATE_RE.lastIndex = m.index + 1;
        if (!ok(d)) continue;
        const c = cand[d] || (cand[d] = { d: d, score: -2 });
        c.score += 2 + (alone ? 3 : 0) + (near ? 3 : 0) - (period ? 2 : 0);
      }
    });
    const isoRe = /(20\d{2})-(\d{2})-(\d{2})/g;
    let m;
    while ((m = isoRe.exec(text || ''))) {
      const d = isoDate(+m[1], +m[2], +m[3]);
      if (ok(d)) { const c = cand[d] || (cand[d] = { d: d, score: -2 }); c.score += 2; }
    }
    const list = Object.keys(cand).map(function (k) { return cand[k]; });
    if (!list.length) return null;
    list.sort(function (a, b) { return b.score - a.score || (a.d < b.d ? 1 : -1); });
    return list[0].d;
  }

  // Schlüsselwörter für die Endsumme, nach Verlässlichkeit sortiert
  const TOTAL_KEYS = [
    /zu\s*zahlen/i,
    /gesamt\s*betrag|gesamtsumme|gesamt/i,
    /(?<!zwischen)summe/i,
    /total|betrag/i
  ];
  const NOT_TOTAL = /zwischensumme|gegeben|r[üu]ckgeld|zur[üu]ck|wechselgeld|netto|mwst|ust|steuer|rabatt|pfand/i;

  function findTotal(lines) {
    for (const key of TOTAL_KEYS) {
      for (let i = 0; i < lines.length; i++) {
        if (!key.test(lines[i]) || NOT_TOTAL.test(lines[i])) continue;
        let a = amountsIn(lines[i]);
        // Betrag steht manchmal in der nächsten Zeile
        if (!a.length && lines[i + 1]) a = amountsIn(lines[i + 1]);
        const pos = a.filter(function (c) { return c > 0; });
        if (pos.length) return pos[pos.length - 1];
      }
    }
    // Fallback: größter Betrag außerhalb von Gegeben/Rückgeld-Zeilen
    let best = null;
    for (const l of lines) {
      if (NOT_TOTAL.test(l)) continue;
      for (const c of amountsIn(l)) if (c > 0 && c < 1000000 && (best === null || c > best)) best = c;
    }
    return best;
  }

  function findPayment(text) {
    if (/ec[\s-]?karte|girocard|kartenzahlung|visa|mastercard|maestro|kontaktlos|apple\s*pay|google\s*pay/i.test(text)) return 'Karte';
    if (/\bbar\b|bargeld|gegeben/i.test(text)) return 'Bar';
    return null;
  }

  function parseOcrText(text) {
    const lines = String(text || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    return {
      haendler: findMerchant(lines),
      datum: findDate(text || ''),
      betrag: findTotal(lines),
      zahlungsart: findPayment(text || '')
    };
  }

  // QR-Werte haben Vorrang, Händler kommt immer aus dem OCR-Text
  function combine(ocr, qr) {
    ocr = ocr || {};
    qr = qr || {};
    return {
      haendler: ocr.haendler || null,
      datum: qr.datum || ocr.datum || null,
      betrag: qr.betrag || ocr.betrag || null,
      zahlungsart: qr.zahlungsart || ocr.zahlungsart || null,
      quelle: qr.betrag ? 'qr' : 'ocr'
    };
  }

  // ---------- Tagesabschluss (Z-Bon) der eigenen Kasse ----------
  const RATE_RE = {
    19: /(^|[^\d.,])19\s?(?:[.,]0{1,2})?\s?%/,
    7: /(^|[^\d.,])7\s?(?:[.,]0{1,2})?\s?%/,
    0: /(^|[^\d.,])0\s?(?:[.,]0{1,2})?\s?%/
  };
  const anyRate = function (l) { return RATE_RE[19].test(l) || RATE_RE[7].test(l) || RATE_RE[0].test(l); };
  // Prozentangaben ("19,00%") sind keine Beträge
  const pos = function (l) {
    return amountsIn(l.replace(/\d{1,3}\s?(?:[.,]\d{1,2})?\s?%/g, ' ')).filter(function (c) { return c > 0; });
  };
  const lastAmt = function (l) { const a = pos(l); return a.length ? a[a.length - 1] : null; };

  // Bruttoumsatz eines Steuersatzes. Kommt in drei Formen vor:
  //  "Umsatz 19% 238,00" | "19% Netto 84,03 MwSt 15,97 Brutto 100,00" | Block mit Netto/MwSt/Brutto-Zeilen
  function rateGross(lines, rate) {
    const re = RATE_RE[rate];
    let best = null;
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      if (rate === 0 && /gutschein/i.test(lines[i]) && /einl|eingel/i.test(lines[i])) continue;
      const l = lines[i].toLowerCase();
      const a = pos(lines[i]);
      let val = null, score = -9;
      if (a.length >= 2) { val = Math.max.apply(null, a); score = 2; }
      else if (a.length === 1) {
        val = a[0];
        score = /brutto|umsatz|summe|gesamt|verkauf/.test(l) ? 3 : /mwst|ust|steuer|netto/.test(l) ? -2 : 1;
      }
      // Block-Format: Steuersatz steht allein, Brutto folgt in einer der nächsten Zeilen
      for (let j = i + 1; a.length === 0 && j <= i + 4 && j < lines.length; j++) {
        if (anyRate(lines[j]) || /summe|gesamt|total/i.test(lines[j])) break;
        if (/brutto|umsatz/i.test(lines[j])) {
          const v = lastAmt(lines[j]);
          if (v !== null && score < 4) { val = v; score = 4; }
          break;
        }
      }
      if (val !== null && (!best || score > best.score || (score === best.score && val > best.val))) best = { val: val, score: score };
    }
    return best && best.score >= 0 ? best.val : null;
  }

  const CARD_RE = /\bec\b|ec[-\s]?karte|girocard|kartenzahlung|karte|maestro|visa|master\s?card|amex|american\s?express|kredit|v\s?pay|kontaktlos|sumup|zettle/i;
  const IGNORE_RE = /storno|retoure|anzahl|trinkgeld/i;

  function cardTotal(lines) {
    let unbar = null, gesamt = null, sum = 0, found = false;
    for (const l of lines) {
      if (IGNORE_RE.test(l) || /gutschein/i.test(l)) continue;
      const v = lastAmt(l);
      if (v === null) continue;
      if (/unbar/i.test(l)) { if (unbar === null) unbar = v; continue; }
      if (CARD_RE.test(l)) {
        if (/gesamt|summe|total/i.test(l)) { if (gesamt === null) gesamt = v; }
        else { sum += v; found = true; }
      }
    }
    return unbar !== null ? unbar : gesamt !== null ? gesamt : found ? sum : null;
  }

  function findLine(lines, re, exclude) {
    for (const l of lines) {
      if (!re.test(l) || (exclude && exclude.test(l))) continue;
      const v = lastAmt(l);
      if (v !== null) return v;
    }
    return null;
  }

  // ---------- Kassenabrechnung im Waagenkassen-Format (Bizerba/Mettler u. ä.) ----------
  // Block "Mehrwertsteuer":   "1   7.00 %"  /  "53.15 von 812.40"   (Satz kann mehrfach vorkommen)
  const stripPct = function (l) { return l.replace(/\d{1,3}\s?(?:[.,]\s?\d{1,2})?\s?%/g, ' '); };
  const absLast = function (l) { const a = amountsIn(stripPct(l)); return a.length ? Math.abs(a[a.length - 1]) : null; };

  // Steuersatz aus "Steuer von Betrag" ableiten (robust gegen falsch gelesene Prozentangaben).
  // Liefert {r, brutto}. Betrag ist brutto oder netto – beides wird geprüft.
  function inferRate(tax, base, hint) {
    let best = null;
    for (const r of [0, 7, 19]) {
      for (const netto of [false, true]) {
        const exp = r ? Math.round(base * r / (netto ? 100 : 100 + r)) : 0;
        const err = Math.abs(tax - exp);
        const score = err - (r === hint ? 1.5 : 0) + (netto ? 0.5 : 0);   // leichte Vorliebe für gedruckten Satz und brutto
        if (!best || score < best.score) best = { r: r, brutto: netto ? base + tax : base, score: score, err: err, exp: exp };
      }
    }
    // Weicht die Steuer stark ab, dem gedruckten Satz vertrauen (falls plausibel)
    if (best.err > Math.max(3, best.exp * 0.03) && (hint === 0 || hint === 7 || hint === 19)) return { r: hint, brutto: base };
    return best;
  }

  // "53.15 von 812.40" – erkennt die Zeile auch ohne Überschrift (OCR-Varianten: "uon", "v0n", "vom")
  const VON_RE = /\d\s?[.,]\s?\d{2}\s*\S?\s*\b[vu][o0][nm]\b\s*-?\d/i;

  function parseTaxBlock(lines) {
    const sums = {}, seen = {}, items = [];
    let hint = null, inBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/mehr.{0,4}steuer|mehrwert|^\W*mwst\W*$/i.test(l)) { inBlock = true; continue; }
      if (inBlock && /umsatz\s*gel|gel[öo]scht|^\W*summe\b|^\W*gesamt/i.test(l) && !VON_RE.test(l)) inBlock = false;
      const m = l.match(/(\d{1,2})\s?[.,]\s?(\d{2})\s?%/g);
      if (m) hint = parseInt(m[m.length - 1].replace(/^\D*?(\d{1,2})\s?[.,].*$/, '$1'), 10);
      const a = amountsIn(stripPct(l)).map(Math.abs);
      if (a.length >= 2 && (VON_RE.test(l) || (inBlock && !m))) {
        const res = inferRate(a[0], a[a.length - 1], hint);
        sums[res.r] = (sums[res.r] || 0) + res.brutto; seen[res.r] = true;
        items.push({ r: res.r, brutto: res.brutto });
        hint = null;
      }
    }
    if (!Object.keys(seen).length) return null;
    return { u19: sums[19] || null, u7: sums[7] || null, u0: sums[0] || null, items: items };
  }

  // Block "Zahlungsmittel": Abschnitte "Bar", "(EC)", "(Gutschein)" … mit Zahlungen, Rückgeld, Ausgaben …
  const PAY_KEYS = [['zahlungen', /zahlungen/i], ['rueckgeld', /r[üu]ckgeld/i], ['einnahmen', /einnahmen/i], ['ausgaben', /ausgaben/i],
    ['stockgeld', /stockgeld/i], ['ablieferung', /ablieferung/i], ['soll', /\bsoll\b/i], ['ist', /\bist\b/i], ['differenz', /differenz/i]];

  function parsePayments(lines) {
    // Beginn: Überschrift "Zahlungsmittel" (oft eingerahmt und unlesbar) oder der Abschnitt "Bar"
    let start = lines.findIndex(function (l) { return /zahlungsmittel|zahlungsarten/i.test(l); });
    if (start < 0) {
      const bar = lines.findIndex(function (l) { return /^\W*bar\W*(?:€|e|ε|c)?\W*$/i.test(l); });
      if (bar >= 0) start = bar - 1;
    }
    let implicitBar = false;
    if (start < 0) {
      const z = lines.findIndex(function (l) { return /zahlungen/i.test(l); });
      if (z < 0) return null;
      start = z - 1; implicitBar = true;
    }
    const secs = [];
    let sec = null;
    if (implicitBar) { sec = { name: 'bar', v: {} }; secs.push(sec); }
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/auf[\s\-\/=]*ab|abschlag|mehrwert|warengruppe/i.test(l) || VON_RE.test(l)) break;
      const key = PAY_KEYS.find(function (k) { return k[1].test(l); });
      if (!key) {
        if (amountsIn(l).length) continue;                       // z. B. "1 EC = 1.00 €"
        const name = l.replace(/[^A-Za-zÄÖÜäöüß\s\-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
        if (name && name.length <= 24) { sec = { name: name, v: {} }; secs.push(sec); }
        continue;
      }
      if (!sec) continue;
      let v = absLast(l);
      const count = l.match(/^\W*(\d+)\s+[A-Za-zÄÖÜäöü]/);
      if (count && /^0+$/.test(count[1]) && /einnahmen|ausgaben|stockgeld|ablieferung/.test(key[0])) v = 0;
      if (v !== null && !(key[0] in sec.v)) sec.v[key[0]] = v;
    }
    if (!secs.length) return null;
    const res = { ec: null, gutschein: null, barLautBon: null, aus: null, ein: null, abl: null };
    const nz = function (v) { return v && v >= 100 ? v : null; };
    const plus = function (a, b) { return b ? (a || 0) + b : a; };
    secs.forEach(function (s, idx) {
      const v = s.v, paid = v.zahlungen !== undefined ? v.zahlungen : v.soll;
      const other = /gutsch|(^|\s)ec(\s|$)|karte|giro|kredit|visa|master|maestro|unbar/.test(s.name);
      // "Bar" steht immer als erster Abschnitt; die Überschrift ist oft unleserlich ("ar", "8ar")
      if (/(^|\s)bar(\s|$)/.test(s.name) || (idx === secs.findIndex(function (x) { return 'zahlungen' in x.v; }) && !other)) {
        // Nebenwerte nur übernehmen, wenn sie zum Soll passen (sonst Lesefehler wie "0.08")
        if (v.soll !== undefined && v.zahlungen !== undefined) {
          const base = v.zahlungen - (v.rueckgeld || 0) + (v.stockgeld || 0);
          const full = base + (v.einnahmen || 0) - (v.ausgaben || 0) - (v.ablieferung || 0);
          if (full !== v.soll && base === v.soll) { v.einnahmen = 0; v.ausgaben = 0; v.ablieferung = 0; }
        }
        if (v.zahlungen !== undefined) res.barLautBon = v.zahlungen - (v.rueckgeld || 0);
        res._bar = { zahlungen: v.zahlungen, rueckgeld: v.rueckgeld || 0 };
        res.ein = nz(v.einnahmen); res.aus = nz(v.ausgaben); res.abl = nz(v.ablieferung);
      } else if (/gutsch/.test(s.name)) res.gutschein = plus(res.gutschein, paid);
      else if (other) res.ec = plus(res.ec, paid);
    });
    return res;
  }

  function parseZBon(text) {
    const lines = String(text || '').split(/\r?\n/).map(function (l) {
      return l.trim()
        .replace(/(\d[.,]\d{2})\d(?=\s|$)/g, '$1')   // Störzeichen am Bonrand: "250,508" → "250,50"
        .replace(/[©®]/g, '0');                       // "712,2©" → "712,20"
    }).filter(Boolean);

    // Allgemeines Format (Umsatz je Steuersatz, Zahlungsarten als Einzelzeilen)
    let u0 = rateGross(lines, 0);
    if (u0 === null) u0 = findLine(lines, /gutschein\w*[\s\-:]*(?:verk|ausgabe|aufladung)|verk\w*[\s\-:]*gutschein/i);
    const out = {
      datum: findDate(text || ''),
      u19: rateGross(lines, 19),
      u7: rateGross(lines, 7),
      u0: u0,
      ec: cardTotal(lines),
      gutschein: findLine(lines, /gutschein\w*[\s\-:]*(?:einl|eingel|zahl|bezahl|annahme)|einl\w*[\s\-:]*gutschein|zahl\w*[\s\-:]*gutschein/i),
      barLautBon: findLine(lines, /(^|\s)bar(\s|:|$)|barzahlung|bargeld/i, /unbar|gegeben|zur[üu]ck|r[üu]ckgeld|wechsel|einlage|entnahme|auszahl|einzahl|bestand|soll/i),
      // Bargeld, das ohne Verkauf aus der Kasse genommen bzw. hineingelegt wurde
      aus: findLine(lines, /aus[\s\-]?zahlung|ausgabe|entnahme|paid\s*out/i, /gutschein|r[üu]ckgeld|wechselgeld/i),
      ein: findLine(lines, /ein[\s\-]?zahlung|einlage|paid\s*in/i, /gutschein/i),
      abl: null
    };

    // Waagenkassen-Format: Blöcke haben Vorrang, wenn sie gefunden werden
    const tax = parseTaxBlock(lines);
    if (tax) { out.u19 = tax.u19; out.u7 = tax.u7; out.u0 = tax.u0; }
    const pay = parsePayments(lines);
    if (pay) Object.assign(out, pay);
    out.korrigiert = null;
    if (tax && pay && pay._bar && pay._bar.zahlungen !== undefined) reconcile(out, tax.items, pay._bar);
    delete out._bar;
    return out;
  }

  // Gegenprobe: Summe der Umsätze = Bar (Zahlungen − Rückgeld) + EC + Gutscheine.
  // Geht sie nicht auf und behebt genau ein Ziffern-Tausch 8→0 die Differenz (die Texterkennung liest
  // bei diesem Druckbild eine 0 gelegentlich als 8, nie umgekehrt),
  // wird dieser Wert korrigiert und im Ergebnis vermerkt.
  function swaps(c) {
    const str = String(c), out = [];
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '8') out.push(parseInt(str.slice(0, i) + '0' + str.slice(i + 1), 10));
    }
    return out;
  }
  function reconcile(z, items, bar) {
    const n = function (v) { return v || 0; };
    const sales = items.reduce(function (a, it) { return a + it.brutto; }, 0);
    const paid = function (zahl, rueck, ec) { return zahl - rueck + ec + n(z.gutschein); };
    if (sales === paid(bar.zahlungen, bar.rueckgeld, n(z.ec))) return;
    const fixes = [];
    items.forEach(function (it, i) {
      swaps(it.brutto).forEach(function (v) {
        if (sales - it.brutto + v === paid(bar.zahlungen, bar.rueckgeld, n(z.ec))) fixes.push({ kind: 'item', i: i, v: v });
      });
    });
    swaps(bar.zahlungen).forEach(function (v) { if (sales === paid(v, bar.rueckgeld, n(z.ec))) fixes.push({ kind: 'zahl', v: v }); });
    swaps(bar.rueckgeld).forEach(function (v) { if (sales === paid(bar.zahlungen, v, n(z.ec))) fixes.push({ kind: 'rueck', v: v }); });
    if (z.ec) swaps(z.ec).forEach(function (v) { if (sales === paid(bar.zahlungen, bar.rueckgeld, v)) fixes.push({ kind: 'ec', v: v }); });
    if (fixes.length !== 1) return;
    const f = fixes[0];
    if (f.kind === 'item') {
      const it = items[f.i], key = it.r === 19 ? 'u19' : it.r === 7 ? 'u7' : 'u0';
      z[key] = n(z[key]) - it.brutto + f.v; z.korrigiert = key;
    } else if (f.kind === 'ec') { z.ec = f.v; z.korrigiert = 'ec'; }
    else {
      const zahl = f.kind === 'zahl' ? f.v : bar.zahlungen, rueck = f.kind === 'rueck' ? f.v : bar.rueckgeld;
      z.barLautBon = zahl - rueck; z.korrigiert = 'barLautBon';
    }
  }

  // Bargeld aus Verkäufen = 19 % + 7 % + 0 % − EC/Karte − eingelöste Gutscheine
  // (entspricht „Bar“ unter den Zahlungsarten auf dem Bon)
  function zbonBar(z) {
    const n = function (v) { return v || 0; };
    return n(z.u19) + n(z.u7) + n(z.u0) - n(z.ec) - n(z.gutschein);
  }

  function formatCents(c) {
    if (c === null || c === undefined) return '';
    const neg = c < 0; c = Math.abs(c);
    const e = Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (neg ? '-' : '') + e + ',' + pad(c % 100);
  }

  const api = { parseTseQr: parseTseQr, parseOcrText: parseOcrText, parseZBon: parseZBon, zbonBar: zbonBar, combine: combine, toCents: toCents, formatCents: formatCents };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BonParser = api;
})(this);
