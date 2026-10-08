/* Minimaler PDF-Schreiber ohne Bibliothek: A4, Helvetica/Helvetica-Bold (WinAnsi, inkl. Umlaute und €),
   Text, Linien, Flächen, mehrere Seiten. Läuft im Browser (window.PdfLite) und in Node (Tests). */
(function (root) {
  'use strict';

  // Zeichenbreiten (1/1000 em) für Zeichen 32–255 in WinAnsiEncoding
  const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 350, 556, 350, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350, 350, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 350, 500, 667, 278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611, 667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500];
  const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 350, 556, 350, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350, 350, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 350, 500, 667, 278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611, 722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278, 611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556];

  // Unicode → WinAnsi (Latin-1 plus Sonderzeichen 0x80–0x9F)
  const SPECIAL = { 0x20AC: 0x80, 0x201A: 0x82, 0x201E: 0x84, 0x2026: 0x85, 0x2013: 0x96, 0x2014: 0x97,
    0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2212: 0x2D };
  function code(ch) {
    const c = ch.codePointAt(0);
    if (SPECIAL[c] !== undefined) return SPECIAL[c];
    if (c >= 32 && c <= 126) return c;
    if (c >= 160 && c <= 255) return c;
    return 63; // '?'
  }

  function textWidth(str, size, bold) {
    const tbl = bold ? W_BOLD : W_REG;
    let w = 0;
    for (const ch of String(str)) { const c = code(ch); w += tbl[c - 32] || 0; }
    return w * size / 1000;
  }

  function esc(bytes) {
    let s = '';
    for (const b of bytes) {
      if (b === 40 || b === 41 || b === 92) s += '\\' + String.fromCharCode(b);
      else if (b < 32 || b > 126) s += '\\' + b.toString(8).padStart(3, '0');
      else s += String.fromCharCode(b);
    }
    return s;
  }

  const n = function (v) { return (Math.round(v * 100) / 100).toString(); };

  function Doc(opts) {
    opts = opts || {};
    this.w = opts.landscape ? 842 : 595;
    this.h = opts.landscape ? 595 : 842;
    this.pages = [];
    this.cur = null;
    this.title = opts.title || '';
  }
  Doc.prototype.addPage = function () { this.cur = []; this.pages.push(this.cur); return this; };
  // y von oben gemessen (bequemer fürs Layout)
  Doc.prototype.text = function (x, y, str, o) {
    o = o || {};
    const size = o.size || 9, bold = !!o.bold;
    str = String(str === null || str === undefined ? '' : str);
    if (o.maxWidth) {                       // zu langen Text kürzen
      while (str.length > 1 && textWidth(str, size, bold) > o.maxWidth) str = str.slice(0, -2) + '…';
    }
    let tx = x;
    if (o.align === 'right') tx = x - textWidth(str, size, bold);
    else if (o.align === 'center') tx = x - textWidth(str, size, bold) / 2;
    const bytes = Array.from(str, code);
    const gray = o.gray !== undefined ? o.gray : 0;
    this.cur.push(n(gray) + ' g BT /' + (bold ? 'F2' : 'F1') + ' ' + n(size) + ' Tf ' + n(tx) + ' ' + n(this.h - y) + ' Td (' + esc(bytes) + ') Tj ET');
    return this;
  };
  Doc.prototype.line = function (x1, y1, x2, y2, o) {
    o = o || {};
    this.cur.push(n(o.gray || 0) + ' G ' + n(o.width || 0.5) + ' w ' + n(x1) + ' ' + n(this.h - y1) + ' m ' + n(x2) + ' ' + n(this.h - y2) + ' l S');
    return this;
  };
  Doc.prototype.rect = function (x, y, w, h, o) {
    o = o || {};
    this.cur.push(n(o.fill !== undefined ? o.fill : 0.92) + ' g ' + n(x) + ' ' + n(this.h - y - h) + ' ' + n(w) + ' ' + n(h) + ' re f');
    return this;
  };

  Doc.prototype.bytes = function () {
    const enc = new TextEncoder();
    const parts = [];
    const offsets = [];
    let len = 0;
    const push = function (s) { const b = typeof s === 'string' ? enc.encode(s) : s; parts.push(b); len += b.length; };
    const obj = function (id, body) { offsets[id] = len; push(id + ' 0 obj\n' + body + '\nendobj\n'); };

    push('%PDF-1.4\n');
    push(new Uint8Array([37, 226, 227, 207, 211, 10]));
    const nPages = this.pages.length;
    // 1 Katalog, 2 Seitenbaum, 3/4 Schriften, 5 Info, ab 6: je Seite Page + Content
    const pageIds = this.pages.map(function (_, i) { return 6 + i * 2; });
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [' + pageIds.map(function (id) { return id + ' 0 R'; }).join(' ') + '] /Count ' + nPages + ' >>');
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const t = Array.from(this.title, code);
    obj(5, '<< /Title (' + esc(t) + ') /Producer (Kassenbuch-App) >>');
    const self = this;
    this.pages.forEach(function (ops, i) {
      const content = ops.join('\n');
      const cb = enc.encode(content);
      obj(pageIds[i], '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + self.w + ' ' + self.h + '] ' +
        '/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' + (pageIds[i] + 1) + ' 0 R >>');
      offsets[pageIds[i] + 1] = len;
      push((pageIds[i] + 1) + ' 0 obj\n<< /Length ' + cb.length + ' >>\nstream\n');
      push(cb);
      push('\nendstream\nendobj\n');
    });
    const count = 6 + nPages * 2;
    const xref = len;
    let x = 'xref\n0 ' + count + '\n0000000000 65535 f \n';
    for (let i = 1; i < count; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    push(x + 'trailer\n<< /Size ' + count + ' /Root 1 0 R /Info 5 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };

  const api = { Doc: Doc, textWidth: textWidth };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PdfLite = api;
})(this);
