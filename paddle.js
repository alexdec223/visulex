/* PaddleOCR (PP-OCRv4 mobile, the same models RapidOCR uses on the
   Raspberry Pi) running in the browser with onnxruntime-web.
   Detection finds text lines, recognition reads each line, and the
   recogniser's character timing is used to box each word.
   Everything runs on the device. */

const ORT_VERSION = "1.20.1";

class PaddleOCR {
  constructor(base = "") {
    this.base = base;
    this.ready = false;
    this.detMaxSide = 1600;     // detection image size: speed vs small text
    this.detThresh = 0.3;
    this.boxThresh = 0.5;
    this.unclip = 1.6;
    this.minLineScore = 0.5;
  }

  async _fetchModel(path, onProgress, share, offset) {
    const res = await fetch(this.base + path);
    if (!res.ok) throw new Error(`Could not load ${path}`);
    const total = Number(res.headers.get("content-length")) || 0;
    if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    const out = new Uint8Array(total);
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.set(value, got);
      got += value.length;
      if (onProgress) onProgress(offset + share * (got / total));
    }
    return out;
  }

  async load(onProgress) {
    if (this.ready) return;
    ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
    const det = await this._fetchModel("models/det.onnx", onProgress, 0.3, 0);
    const rec = await this._fetchModel("models/rec.onnx", onProgress, 0.6, 0.3);
    const keys = await (await fetch(this.base + "models/rec_keys.txt")).text();
    this.chars = ["", ...keys.split("\n"), " "];
    this.det = await ort.InferenceSession.create(det, opts);
    if (onProgress) onProgress(0.95);
    this.rec = await ort.InferenceSession.create(rec, opts);
    if (onProgress) onProgress(1);
    this.ready = true;
  }

  /* Pixels of a canvas region as a normalised BGR tensor. */
  _tensor(ctxCanvas, width, height, padWidth = width) {
    const data = ctxCanvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;
    const plane = padWidth * height;
    const t = new Float32Array(3 * plane);           // zero = grey after normalising
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const s = (y * width + x) * 4;
        const d = y * padWidth + x;
        t[d] = data[s + 2] / 127.5 - 1;              // B
        t[plane + d] = data[s + 1] / 127.5 - 1;      // G
        t[2 * plane + d] = data[s] / 127.5 - 1;      // R
      }
    }
    return new ort.Tensor("float32", t, [1, 3, height, padWidth]);
  }

  async _detect(src) {
    const w = src.width, h = src.height;
    const ratio = this.detMaxSide / Math.max(w, h);
    const rw = Math.max(32, Math.round((w * ratio) / 32) * 32);
    const rh = Math.max(32, Math.round((h * ratio) / 32) * 32);
    const c = document.createElement("canvas");
    c.width = rw; c.height = rh;
    const cx = c.getContext("2d");
    cx.imageSmoothingQuality = "high";
    cx.drawImage(src, 0, 0, rw, rh);
    const out = await this.det.run({ [this.det.inputNames[0]]: this._tensor(c, rw, rh) });
    const prob = out[this.det.outputNames[0]].data;

    // Threshold and dilate (2 x 2), like PaddleOCR's DB post processing.
    const bin = new Uint8Array(rw * rh);
    for (let i = 0; i < prob.length; i++) if (prob[i] > this.detThresh) bin[i] = 1;
    const dil = new Uint8Array(rw * rh);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const i = y * rw + x;
        if (bin[i] || (x > 0 && bin[i - 1]) || (y > 0 && bin[i - rw]) || (x > 0 && y > 0 && bin[i - rw - 1])) dil[i] = 1;
      }
    }

    // Each connected region is a text line. Its tilt comes from the region's
    // second moments, so slanted lines are cut out along their own angle.
    const seen = new Uint8Array(rw * rh);
    const stack = new Int32Array(rw * rh);
    const pix = new Int32Array(rw * rh);
    const sx = w / rw, sy = h / rh;
    const boxes = [];
    for (let start = 0; start < dil.length; start++) {
      if (!dil[start] || seen[start]) continue;
      let top = 0, n = 0, sum = 0, mx = 0, my = 0;
      stack[top++] = start;
      seen[start] = 1;
      while (top) {
        const i = stack[--top];
        pix[n++] = i;
        const x = i % rw, y = (i / rw) | 0;
        mx += x; my += y; sum += prob[i];
        if (x > 0 && dil[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
        if (x < rw - 1 && dil[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
        if (y > 0 && dil[i - rw] && !seen[i - rw]) { seen[i - rw] = 1; stack[top++] = i - rw; }
        if (y < rh - 1 && dil[i + rw] && !seen[i + rw]) { seen[i + rw] = 1; stack[top++] = i + rw; }
      }
      if (n < 6 || sum / n < this.boxThresh) continue;
      mx /= n; my /= n;
      let cxx = 0, cyy = 0, cxy = 0;
      for (let k = 0; k < n; k++) {
        const dx = (pix[k] % rw) - mx, dy = ((pix[k] / rw) | 0) - my;
        cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
      }
      const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      let ux = Math.cos(th), uy = Math.sin(th);
      if (ux < 0) { ux = -ux; uy = -uy; }
      const vx = -uy, vy = ux;
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (let k = 0; k < n; k++) {
        const dx = (pix[k] % rw) - mx, dy = ((pix[k] / rw) | 0) - my;
        const pu = dx * ux + dy * uy, pv = dx * vx + dy * vy;
        if (pu < u0) u0 = pu; if (pu > u1) u1 = pu; if (pv < v0) v0 = pv; if (pv > v1) v1 = pv;
      }
      u0 -= 0.5; u1 += 0.5; v0 -= 0.5; v1 += 0.5;
      const L = u1 - u0, H = v1 - v0;
      if (Math.min(L, H) < 3) continue;
      const d = (L * H * this.unclip) / (2 * (L + H));   // grow the box like PaddleOCR's unclip
      u0 -= d; u1 += d; v0 -= d; v1 += d;
      boxes.push({
        cx: (mx + u0 * ux + v0 * vx) * sx,                 // top left corner, source pixels
        cy: (my + u0 * uy + v0 * vy) * sy,
        U: [(u1 - u0) * ux * sx, (u1 - u0) * uy * sy],     // along the line
        V: [(v1 - v0) * vx * sx, (v1 - v0) * vy * sy],     // across the line
      });
    }
    return boxes;
  }

  // Corner of the rotated box at fraction a along the line and b across it.
  static _at(box, a, b) {
    return [box.cx + a * box.U[0] + b * box.V[0], box.cy + a * box.U[1] + b * box.V[1]];
  }

  static _bounds(points) {
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }

  async _recognise(src, box) {
    const lu = Math.hypot(box.U[0], box.U[1]), lv = Math.hypot(box.V[0], box.V[1]);
    const H = 48;
    const outW = Math.max(8, Math.min(1600, Math.ceil((H * lu) / lv)));
    const padW = Math.max(320, Math.ceil(outW / 8) * 8);
    // Cut the line out along its tilt: map the rotated box onto an outW x 48 strip.
    const c = document.createElement("canvas");
    c.width = outW; c.height = H;
    const cx = c.getContext("2d");
    cx.imageSmoothingQuality = "high";
    const det = box.U[0] * box.V[1] - box.U[1] * box.V[0];
    const a = (outW * box.V[1]) / det, b = (-H * box.U[1]) / det;
    const c2 = (-outW * box.V[0]) / det, d = (H * box.U[0]) / det;
    cx.setTransform(a, b, c2, d, -(a * box.cx + c2 * box.cy), -(b * box.cx + d * box.cy));
    cx.drawImage(src, 0, 0);
    cx.setTransform(1, 0, 0, 1, 0, 0);

    const out = await this.rec.run({ [this.rec.inputNames[0]]: this._tensor(c, outW, H, padW) });
    const t = out[this.rec.outputNames[0]];
    const [, T, C] = t.dims;
    const p = t.data;
    const chars = [];
    let last = 0;
    for (let s = 0; s < T; s++) {
      let best = 0, bestP = -1;
      const o = s * C;
      for (let k = 0; k < C; k++) if (p[o + k] > bestP) { bestP = p[o + k]; best = k; }
      if (best !== 0 && best !== last) chars.push({ ch: this.chars[best] || "", p: bestP, t: s });
      last = best;
    }
    if (!chars.length) return null;
    const score = chars.reduce((acc, ch) => acc + ch.p, 0) / chars.length;
    const step = padW / T;                                   // strip pixels per timestep
    const frac = (s) => Math.min(1, Math.max(0, ((s + 0.5) * step) / outW));
    const half = step / outW;
    const words = [];
    let cur = null;
    for (const ch of chars) {
      if (ch.ch === " ") { cur = null; continue; }
      if (!cur) { cur = { text: "", first: ch.t, last: ch.t, ps: [] }; words.push(cur); }
      cur.text += ch.ch; cur.last = ch.t; cur.ps.push(ch.p);
    }
    const P = PaddleOCR._at;
    const lineBox = PaddleOCR._bounds([P(box, 0, 0), P(box, 1, 0), P(box, 0, 1), P(box, 1, 1)]);
    return {
      text: chars.map((ch) => ch.ch).join("").trim(),
      score,
      box: lineBox,
      words: words.map((wd) => {
        const f0 = Math.max(0, frac(wd.first) - half * 1.5), f1 = Math.min(1, frac(wd.last) + half * 1.5);
        return {
          text: wd.text,
          confidence: (100 * wd.ps.reduce((x, y) => x + y, 0)) / wd.ps.length,
          bbox: PaddleOCR._bounds([P(box, f0, 0.15), P(box, f1, 0.15), P(box, f0, 0.85), P(box, f1, 0.85)]),
        };
      }),
    };
  }

  /* Returns words in reading order: [{text, confidence (0 to 100), bbox}] */
  async recognize(src) {
    const boxes = await this._detect(src);
    const lines = [];
    for (const box of boxes) {
      const line = await this._recognise(src, box);
      if (line && line.score >= this.minLineScore && line.words.length) lines.push(line);
    }
    // Reading order: rows top to bottom, then left to right.
    lines.sort((a, b) => a.box.y0 - b.box.y0);
    const rows = [];
    for (const line of lines) {
      const mid = (line.box.y0 + line.box.y1) / 2;
      const row = rows.find((r) => Math.abs(r.mid - mid) < (line.box.y1 - line.box.y0) * 0.5);
      if (row) row.lines.push(line); else rows.push({ mid, lines: [line] });
    }
    const words = [];
    rows.forEach((r) => r.lines.sort((a, b) => a.box.x0 - b.box.x0).forEach((l) => words.push(...l.words)));
    return { words, lines };
  }
}
