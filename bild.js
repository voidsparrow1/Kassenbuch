/* Bildvorbereitung für die Texterkennung von Kassenbons.
   1. Papier im Foto finden und zuschneiden (Bons sind lang und schmal)
   2. auf feste Breite skalieren, damit die Schrift groß genug ist
   3. Hintergrund (Schatten, vergilbtes/verblasstes Thermopapier) herausrechnen
   Getestet gegen Tesseract mit nachgestellten Handyfotos (siehe test/ocr). */
(function (root) {
  'use strict';

  const TARGET_W = 1600;          // Breite des Bons nach dem Skalieren
  const MAX_PIXELS = 12e6;        // Grenze für iPhone-Canvas

  function grayFrom(canvas) {
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const g = new Uint8ClampedArray(canvas.width * canvas.height);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    return g;
  }

  function percentile(arr, p) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < arr.length; i++) hist[arr[i]]++;
    const target = arr.length * p;
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
    return 255;
  }

  // Papierbereich: Zeilen/Spalten mit vielen hellen Pixeln. Rückgabe in Koordinaten des Originals.
  function findPaper(img) {
    const W0 = img.naturalWidth || img.width, H0 = img.naturalHeight || img.height;
    const s = Math.min(1, 400 / W0);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(W0 * s)); c.height = Math.max(1, Math.round(H0 * s));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const g = grayFrom(c), W = c.width, H = c.height;
    const t = percentile(g, 0.75) * 0.9;
    const colHits = new Uint32Array(W), rowHits = new Uint32Array(H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g[y * W + x] > t) { colHits[x]++; rowHits[y]++; }
    let x0 = -1, x1 = -1, y0 = -1, y1 = -1;
    for (let x = 0; x < W; x++) if (colHits[x] > H * 0.3) { if (x0 < 0) x0 = x; x1 = x; }
    for (let y = 0; y < H; y++) if (rowHits[y] > W * 0.15) { if (y0 < 0) y0 = y; y1 = y; }
    if (x0 < 0 || y0 < 0 || x1 - x0 < 10 || y1 - y0 < 10) return { x: 0, y: 0, w: W0, h: H0 };
    const pad = 10;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
    return { x: x0 / s, y: y0 / s, w: (x1 - x0 + 1) / s, h: (y1 - y0 + 1) / s };
  }

  // Separabler Maximum-Filter (Radius r): entfernt dünne Schrift aus der Hintergrundschätzung
  function maxFilter(src, W, H, r) {
    const tmp = new Uint8ClampedArray(src.length), out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let x = 0; x < W; x++) {
        let m = 0;
        for (let k = Math.max(0, x - r); k <= Math.min(W - 1, x + r); k++) if (src[o + k] > m) m = src[o + k];
        tmp[o + x] = m;
      }
    }
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        let m = 0;
        for (let k = Math.max(0, y - r); k <= Math.min(H - 1, y + r); k++) if (tmp[k * W + x] > m) m = tmp[k * W + x];
        out[y * W + x] = m;
      }
    }
    return out;
  }

  // Separabler Box-Weichzeichner (Radius r) über laufende Summen
  function boxBlur(src, W, H, r) {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    for (let y = 0; y < H; y++) {
      const o = y * W;
      let sum = 0, n = 0;
      for (let k = 0; k <= Math.min(W - 1, r); k++) { sum += src[o + k]; n++; }
      for (let x = 0; x < W; x++) {
        tmp[o + x] = sum / n;
        const add = x + r + 1, rem = x - r;
        if (add < W) { sum += src[o + add]; n++; }
        if (rem >= 0) { sum -= src[o + rem]; n--; }
      }
    }
    for (let x = 0; x < W; x++) {
      let sum = 0, n = 0;
      for (let k = 0; k <= Math.min(H - 1, r); k++) { sum += tmp[k * W + x]; n++; }
      for (let y = 0; y < H; y++) {
        out[y * W + x] = sum / n;
        const add = y + r + 1, rem = y - r;
        if (add < H) { sum += tmp[add * W + x]; n++; }
        if (rem >= 0) { sum -= tmp[rem * W + x]; n--; }
      }
    }
    return out;
  }

  // Liefert ein Canvas, das direkt an Tesseract geht
  function prepare(img) {
    const p = findPaper(img);
    let s = TARGET_W / p.w;
    s = Math.min(s, 2.5, Math.sqrt(MAX_PIXELS / (p.w * p.h)));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(p.w * s)); c.height = Math.max(1, Math.round(p.h * s));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, p.x, p.y, p.w, p.h, 0, 0, c.width, c.height);

    const W = c.width, H = c.height;
    const g = grayFrom(c);
    const bg = boxBlur(maxFilter(g, W, H, 2), W, H, Math.max(10, Math.floor(W / 25)));
    const out = new Uint8ClampedArray(g.length);
    for (let i = 0; i < g.length; i++) out[i] = Math.min(255, g[i] / Math.max(bg[i], 1) * 255);
    const lo = percentile(out, 0.01);
    const k = 255 / Math.max(1, 255 - lo);
    const id = ctx.createImageData(W, H), d = id.data;
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      const v = Math.max(0, Math.min(255, (out[i] - lo) * k));
      d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    return c;
  }

  root.BonBild = { prepare: prepare, findPaper: findPaper };
})(this);
