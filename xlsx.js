/* Minimaler Excel-Schreiber (.xlsx) ohne externe Bibliothek.
   Schreibt eine formatierte Tabelle mit Datums-, Euro- und Prozentwerten und Formeln. */
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

  /* Allgemeiner Tabellen-Schreiber.
     sheet = {
       name, widths: [12, 30, ...], freezeRows: 3,
       rows: [ [cell, cell, ...], ... ]   // null = leere Zelle, [] = leere Zeile
     }
     cell = { v: Wert, s: 'text'|'bold'|'title'|'date'|'money'|'moneyBold'|'percent', f: 'FORMEL' (optional, v = Ergebnis) }
     Datum als 'YYYY-MM-DD', Geld als Euro-Zahl, Prozent als Anteil (0.19).
     Aufbau wie eine von Excel gespeicherte Datei (sharedStrings, dimension, docProps). */
  const STYLE = { text: 0, bold: 1, date: 2, money: 3, moneyBold: 4, percent: 5, title: 6, header: 7, headerRight: 8 };

  function build(sheet) {
    const enc = new TextEncoder();
    const rows = sheet.rows || [];
    const nCols = Math.max(1, (sheet.widths || []).length, rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0));
    const lastCol = colName(nCols - 1);

    const sst = [], sstIdx = {};
    let sstCount = 0;
    function si(text) {
      text = String(text); sstCount++;
      if (!(text in sstIdx)) { sstIdx[text] = sst.length; sst.push(text); }
      return sstIdx[text];
    }

    let xmlRows = '';
    rows.forEach(function (row, ri) {
      const r = ri + 1;
      let cells = '';
      row.forEach(function (c, ci) {
        if (!c || ((c.v === null || c.v === undefined || c.v === '') && !c.f && !c.s)) return;
        const ref = colName(ci) + r;
        const st = STYLE[c.s || 'text'] || 0;
        const sAttr = st ? ' s="' + st + '"' : '';
        let v = c.v;
        if (c.f) {
          const isNum = typeof v === 'number';
          cells += '<c r="' + ref + '"' + sAttr + (isNum ? '' : ' t="str"') + '><f>' + esc(c.f) + '</f>' +
            (v === null || v === undefined ? '' : '<v>' + (isNum ? +v.toFixed(10) : esc(v)) + '</v>') + '</c>';
        } else if (v === null || v === undefined || v === '') {
          cells += '<c r="' + ref + '"' + sAttr + '/>';
        } else if (c.s === 'date') {
          cells += '<c r="' + ref + '"' + sAttr + '><v>' + excelDate(v) + '</v></c>';
        } else if (typeof v === 'number') {
          cells += '<c r="' + ref + '"' + sAttr + '><v>' + +v.toFixed(10) + '</v></c>';
        } else {
          cells += '<c r="' + ref + '"' + sAttr + ' t="s"><v>' + si(v) + '</v></c>';
        }
      });
      xmlRows += '<row r="' + r + '" spans="1:' + nCols + '">' + cells + '</row>';
    });

    const freeze = sheet.freezeRows || 0;
    const pane = freeze ? '<pane ySplit="' + freeze + '" topLeftCell="A' + (freeze + 1) + '" activePane="bottomLeft" state="frozen"/>' +
      '<selection pane="bottomLeft" activeCell="A' + (freeze + 1) + '" sqref="A' + (freeze + 1) + '"/>' : '';
    const cols = '<cols>' + (sheet.widths || []).map(function (w, i) {
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
    }).join('') + '</cols>';

    const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

    const sheetXml = XML + '<worksheet ' + NS + '>' +
      '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
      '<dimension ref="A1:' + lastCol + Math.max(1, rows.length) + '"/>' +
      '<sheetViews><sheetView tabSelected="1" workbookViewId="0">' + pane + '</sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' + cols +
      '<sheetData>' + xmlRows + '</sheetData>' +
      '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>' +
      '<pageSetup paperSize="9" orientation="landscape" fitToHeight="0"/>' +
      '</worksheet>';

    const sharedStrings = XML + '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + sstCount + '" uniqueCount="' + sst.length + '">' +
      sst.map(function (t) { return '<si><t xml:space="preserve">' + esc(t) + '</t></si>'; }).join('') + '</sst>';

    const styles = XML + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00\\ &quot;€&quot;;[Red]\\-#,##0.00\\ &quot;€&quot;"/></numFmts>' +
      '<fonts count="3">' +
      '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>' +
      '<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>' +
      '<font><b/><sz val="14"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFE7EFEC"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="9">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +                                            // 0 text
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +                               // 1 bold
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +                     // 2 date
      '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +                     // 3 money
      '<xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +       // 4 money bold
      '<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +                       // 5 percent
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +                               // 6 title
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' + // 7 header
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>' + // 8 header rechts
      '</cellXfs><cellStyles count="1"><cellStyle name="Standard" xfId="0" builtinId="0"/></cellStyles>' +
      '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>';

    const sheetName = esc(String(sheet.name || 'Kassenbuch').replace(/[\\\/?*\[\]:]/g, ' ').slice(0, 31));
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const files = [
      ['[Content_Types].xml', XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
        '</Types>'],
      ['_rels/.rels', XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>'],
      ['docProps/app.xml', XML + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
        '<Application>Microsoft Excel</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>' +
        '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Arbeitsblätter</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs>' +
        '<TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>' + sheetName + '</vt:lpstr></vt:vector></TitlesOfParts>' +
        '<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0300</AppVersion></Properties>'],
      ['docProps/core.xml', XML + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        '<dc:title>' + sheetName + '</dc:title><dc:creator>Kassenbuch-App</dc:creator>' +
        '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified></cp:coreProperties>'],
      ['xl/workbook.xml', XML + '<workbook ' + NS + '>' +
        '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="16000" windowHeight="9000" activeTab="0"/></bookViews>' +
        '<sheets><sheet name="' + sheetName + '" sheetId="1" r:id="rId1"/></sheets>' +
        '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>'],
      ['xl/_rels/workbook.xml.rels', XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '</Relationships>'],
      ['xl/worksheets/sheet1.xml', sheetXml],
      ['xl/styles.xml', styles],
      ['xl/sharedStrings.xml', sharedStrings]
    ];
    return zip(files.map(function (f) { return { name: f[0], data: enc.encode(f[1]) }; }));
  }

  const api = { build: build, colName: colName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XlsxLite = api;
})(this);
