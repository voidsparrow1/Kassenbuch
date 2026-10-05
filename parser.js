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

  function findDate(text) {
    const today = new Date();
    const todayIso = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
    const re = /(?:^|[^\d])(\d{1,2})\s?[.\/-]\s?(\d{1,2})\s?[.\/-]\s?(\d{4}|\d{2})(?!\d)/g;
    let m;
    while ((m = re.exec(text))) {
      const d = isoDate(parseInt(m[3], 10), parseInt(m[2], 10), parseInt(m[1], 10));
      if (d && d <= todayIso) return d;
    }
    const iso = text.match(/(20\d{2})-(\d{2})-(\d{2})/);
    if (iso) return isoDate(+iso[1], +iso[2], +iso[3]);
    return null;
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

  function formatCents(c) {
    if (c === null || c === undefined) return '';
    const neg = c < 0; c = Math.abs(c);
    const e = Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (neg ? '-' : '') + e + ',' + pad(c % 100);
  }

  const api = { parseTseQr: parseTseQr, parseOcrText: parseOcrText, combine: combine, toCents: toCents, formatCents: formatCents };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BonParser = api;
})(this);
