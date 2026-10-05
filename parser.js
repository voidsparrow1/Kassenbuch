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
  // Von mehreren plausiblen Daten gewinnt das neueste (Kaufdatum steht meist unten,
  // ältere Zahlenfolgen wie Artikel- oder Filialnummern werden so verworfen).
  function findDate(text, now) {
    const today = now || new Date();
    const todayIso = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
    const minIso = (today.getFullYear() - 2) + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
    const ok = function (d) { return d && d >= minIso && d <= todayIso; };
    const found = [];
    const re = /(?:^|[^\d])(\d{1,2})\s?[.\/-]\s?(\d{1,2})\s?[.\/-]\s?(\d{4}|\d{2})(?!\d)/g;
    let m;
    while ((m = re.exec(text))) {
      const d = isoDate(parseInt(m[3], 10), parseInt(m[2], 10), parseInt(m[1], 10));
      if (ok(d)) found.push(d);
      re.lastIndex = m.index + 1; // überlappende Treffer zulassen
    }
    const isoRe = /(20\d{2})-(\d{2})-(\d{2})/g;
    while ((m = isoRe.exec(text))) {
      const d = isoDate(+m[1], +m[2], +m[3]);
      if (ok(d)) found.push(d);
    }
    if (!found.length) return null;
    return found.sort().pop();
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

  function parseZBon(text) {
    const lines = String(text || '').split(/\r?\n/).map(function (l) {
      return l.trim()
        .replace(/(\d[.,]\d{2})\d(?=\s|$)/g, '$1')   // Störzeichen am Bonrand: "250,508" → "250,50"
        .replace(/[©®]/g, '0');                       // "712,2©" → "712,20"
    }).filter(Boolean);
    let u0 = rateGross(lines, 0);
    if (u0 === null) u0 = findLine(lines, /gutschein\w*[\s\-:]*(?:verk|ausgabe|aufladung)|verk\w*[\s\-:]*gutschein/i);
    return {
      datum: findDate(text || ''),
      u19: rateGross(lines, 19),
      u7: rateGross(lines, 7),
      u0: u0,
      ec: cardTotal(lines),
      gutschein: findLine(lines, /gutschein\w*[\s\-:]*(?:einl|eingel|zahl|bezahl|annahme)|einl\w*[\s\-:]*gutschein|zahl\w*[\s\-:]*gutschein/i),
      barLautBon: findLine(lines, /(^|\s)bar(\s|:|$)|barzahlung|bargeld/i, /unbar|gegeben|zur[üu]ck|r[üu]ckgeld|wechsel|einlage|entnahme|auszahl|einzahl|bestand|soll/i),
      // Bargeld, das ohne Verkauf aus der Kasse genommen bzw. hineingelegt wurde
      aus: findLine(lines, /aus[\s\-]?zahlung|ausgabe|entnahme|paid\s*out/i, /gutschein|r[üu]ckgeld|wechselgeld/i),
      ein: findLine(lines, /ein[\s\-]?zahlung|einlage|paid\s*in/i, /gutschein/i)
    };
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
