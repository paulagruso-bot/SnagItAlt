// OpenSnag — dependency-free animated GIF89a encoder.
// Per-frame median-cut palettes (256 colors) + standard GIF LZW compression.
// Usage: GifEncoder.encode(frames /* ImageData[] */, { delayMs }) -> Uint8Array

(function () {
  'use strict';

  // ------------------------------------------------- color quantization

  // Median-cut to at most 256 colors. Pixels are sampled for speed.
  function buildPalette(data) {
    const px = [];
    const stride = Math.max(1, Math.floor(data.length / 4 / 20000)) * 4;
    for (let i = 0; i < data.length; i += stride) {
      px.push([data[i], data[i + 1], data[i + 2]]);
    }

    let boxes = [px];
    while (boxes.length < 256) {
      // pick the box with the largest channel range
      let bestBox = -1, bestRange = -1, bestChan = 0;
      for (let b = 0; b < boxes.length; b++) {
        const box = boxes[b];
        if (box.length < 2) continue;
        for (let c = 0; c < 3; c++) {
          let mn = 255, mx = 0;
          for (let i = 0; i < box.length; i++) {
            const v = box[i][c];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
          const range = mx - mn;
          if (range > bestRange) { bestRange = range; bestBox = b; bestChan = c; }
        }
      }
      if (bestBox < 0 || bestRange === 0) break;
      const box = boxes[bestBox];
      box.sort((a, b) => a[bestChan] - b[bestChan]);
      const mid = box.length >> 1;
      boxes.splice(bestBox, 1, box.slice(0, mid), box.slice(mid));
    }

    const palette = new Uint8Array(256 * 3);
    const count = boxes.length;
    for (let b = 0; b < count; b++) {
      const box = boxes[b];
      let r = 0, g = 0, bl = 0;
      for (let i = 0; i < box.length; i++) { r += box[i][0]; g += box[i][1]; bl += box[i][2]; }
      const n = Math.max(1, box.length);
      palette[b * 3] = Math.round(r / n);
      palette[b * 3 + 1] = Math.round(g / n);
      palette[b * 3 + 2] = Math.round(bl / n);
    }
    return { palette, count };
  }

  function mapToPalette(data, palette, count) {
    const out = new Uint8Array(data.length / 4);
    const cache = new Map(); // 15-bit rgb -> palette index
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let idx = cache.get(key);
      if (idx === undefined) {
        let best = 0, bestD = Infinity;
        for (let c = 0; c < count; c++) {
          const dr = r - palette[c * 3];
          const dg = g - palette[c * 3 + 1];
          const db = b - palette[c * 3 + 2];
          const d = dr * dr + dg * dg + db * db;
          if (d < bestD) { bestD = d; best = c; }
        }
        idx = best;
        cache.set(key, idx);
      }
      out[p] = idx;
    }
    return out;
  }

  // ------------------------------------------------------- LZW compress

  function lzwEncode(indices, minCodeSize, out) {
    const CLEAR = 1 << minCodeSize;
    const EOI = CLEAR + 1;

    let codeSize = minCodeSize + 1;
    let dict = new Map();
    let next = EOI + 1;

    // bit packer (LSB first) into 255-byte sub-blocks
    let cur = 0, curBits = 0;
    const block = new Uint8Array(255);
    let blockLen = 0;

    const flushBlock = () => {
      if (!blockLen) return;
      out.push(blockLen);
      for (let i = 0; i < blockLen; i++) out.push(block[i]);
      blockLen = 0;
    };
    const emit = (code) => {
      cur |= code << curBits;
      curBits += codeSize;
      while (curBits >= 8) {
        block[blockLen++] = cur & 0xff;
        if (blockLen === 255) flushBlock();
        cur >>= 8;
        curBits -= 8;
      }
    };
    const resetDict = () => {
      dict = new Map();
      next = EOI + 1;
      codeSize = minCodeSize + 1;
    };

    emit(CLEAR);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      const found = dict.get(key);
      if (found !== undefined) {
        prefix = found;
        continue;
      }
      emit(prefix);
      dict.set(key, next++);
      if (next === (1 << codeSize) + 1 && codeSize < 12) codeSize++;
      if (next >= 4096) {
        emit(CLEAR);
        resetDict();
      }
      prefix = k;
    }
    emit(prefix);
    emit(EOI);
    if (curBits > 0) {
      block[blockLen++] = cur & 0xff;
      if (blockLen === 255) flushBlock();
    }
    flushBlock();
    out.push(0); // block terminator
  }

  // ------------------------------------------------------------ writer

  function encode(frames, opts = {}) {
    if (!frames.length) throw new Error('no frames');
    const delay = Math.max(2, Math.round((opts.delayMs || 100) / 10)); // in 1/100 s
    const w = frames[0].width;
    const h = frames[0].height;
    const out = [];
    const bytes = (...b) => out.push(...b);
    const u16 = (v) => bytes(v & 0xff, (v >> 8) & 0xff);

    // header + logical screen descriptor (no global color table)
    bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // "GIF89a"
    u16(w); u16(h);
    bytes(0x70, 0, 0); // packed (no GCT, 8-bit color resolution), bg, aspect

    // NETSCAPE looping extension (loop forever)
    bytes(0x21, 0xff, 0x0b);
    for (const ch of 'NETSCAPE2.0') bytes(ch.charCodeAt(0));
    bytes(0x03, 0x01); u16(0); bytes(0x00);

    for (const frame of frames) {
      const { palette, count } = buildPalette(frame.data);
      const indices = mapToPalette(frame.data, palette, count);

      // graphic control extension
      bytes(0x21, 0xf9, 0x04, 0x04 /* disposal: do not dispose */);
      u16(delay);
      bytes(0x00, 0x00);

      // image descriptor with a 256-entry local color table
      bytes(0x2c);
      u16(0); u16(0); u16(frame.width); u16(frame.height);
      bytes(0x87); // local color table, 2^(7+1)=256 entries

      for (let i = 0; i < 256 * 3; i++) out.push(palette[i] || 0);

      bytes(0x08); // LZW minimum code size
      lzwEncode(indices, 8, out);
    }

    bytes(0x3b); // trailer
    return Uint8Array.from(out);
  }

  window.GifEncoder = { encode };
})();
