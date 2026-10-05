/* Minimaler Excel-Schreiber (.xlsx) ohne externe Bibliothek.
   Erzeugt eine Tabelle mit Kopfzeile, echten Datums- und Eurowerten und Summenzeile. */
(function (root) {
  'use strict';

  // ---------- ZIP (unkomprimiert) ----------
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zip(files) { // files: [{name, data: Uint8Array}]
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const chunks = [], central = [];
    let offset = 0;

    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, f.data.length, true); lh.setUint32(22, f.data.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      chunks.push(new Uint8Array(lh.buffer), name, f.data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, f.data.length, true);
      ch.setUint32(24, f.data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + f.data.length;
    }
    const cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob(chunks.concat(central, [new Uint8Array(end.buffer)]),
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // ---------- Tabelle ----------
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; })
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  }
  function colName(i) { return String.fromCharCode(65 + i); }
  function excelDate(iso) { // "2026-10-02" → Excel-Seriennummer
    const p = iso.split('-').map(Number);
    return Math.round((Date.UTC(p[0], p[1] - 1, p[2]) - Date.UTC(1899, 11, 30)) / 86400000);
  }

  /* columns: [{title, type: 'date'|'money'|'text', width, key}]
     rows: Objekte; money in Cent */
  function build(columns, rows, opts) {
    opts = opts || {};
    const enc = new TextEncoder();
    // Stile: 0 normal, 1 fett, 2 Datum, 3 Euro, 4 Euro fett
    const STYLE = { text: 0, date: 2, money: 3 };
    let sheetRows = '';
    let r = 1;

    sheetRows += '<row r="1">' + columns.map(function (c, i) {
      return '<c r="' + colName(i) + '1" t="inlineStr" s="1"><is><t>' + esc(c.title) + '</t></is></c>';
    }).join('') + '</row>';

    let sum = 0;
    for (const row of rows) {
      r++;
      sheetRows += '<row r="' + r + '">';
      columns.forEach(function (c, i) {
        const ref = colName(i) + r;
        const v = row[c.key];
        if (v === null || v === undefined || v === '') return;
        if (c.type === 'date') sheetRows += '<c r="' + ref + '" s="2"><v>' + excelDate(v) + '</v></c>';
        else if (c.type === 'money') { sum += v; sheetRows += '<c r="' + ref + '" s="3"><v>' + (v / 100).toFixed(2) + '</v></c>'; }
        else sheetRows += '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>';
      });
      sheetRows += '</row>';
    }

    // Summenzeile
    const moneyIdx = columns.findIndex(function (c) { return c.type === 'money'; });
    if (moneyIdx >= 0 && rows.length) {
      const sr = r + 2;
      const label = moneyIdx > 0 ? '<c r="' + colName(moneyIdx - 1) + sr + '" t="inlineStr" s="1"><is><t>Summe</t></is></c>' : '';
      const m = colName(moneyIdx);
      sheetRows += '<row r="' + sr + '">' + label + '<c r="' + m + sr + '" s="4"><f>SUM(' + m + '2:' + m + r + ')</f><v>' +
        (sum / 100).toFixed(2) + '</v></c></row>';
    }

    const cols = '<cols>' + columns.map(function (c, i) {
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (c.width || 14) + '" customWidth="1"/>';
    }).join('') + '</cols>';

    const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      cols + '<sheetData>' + sheetRows + '</sheetData>' +
      (rows.length ? '<autoFilter ref="A1:' + colName(columns.length - 1) + r + '"/>' : '') +
      '</worksheet>';

    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="2"><numFmt numFmtId="164" formatCode="DD.MM.YYYY"/><numFmt numFmtId="165" formatCode="#,##0.00\\ &quot;€&quot;"/></numFmts>' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="5">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
      '</cellXfs><cellStyles count="1"><cellStyle name="Standard" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

    const sheetName = esc((opts.sheetName || 'Kassenbuch').slice(0, 31));
    const files = {
      '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>',
      '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
      'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="' + sheetName + '" sheetId="1" r:id="rId1"/></sheets>' +
        (rows.length ? '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">\'' + sheetName + '\'!$A$1:$' + colName(columns.length - 1) + '$' + r + '</definedName></definedNames>' : '') +
        '</workbook>',
      'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
      'xl/worksheets/sheet1.xml': sheet,
      'xl/styles.xml': styles
    };
    return zip(Object.keys(files).map(function (k) { return { name: k, data: enc.encode(files[k]) }; }));
  }

  const api = { build: build };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XlsxLite = api;
})(this);
