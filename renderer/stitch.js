// OpenSnag — panoramic capture stitcher.
// Takes a series of equal-width screenshots captured while the user scrolls
// and joins them vertically by finding the best-matching overlap between
// consecutive frames (normalized sum of absolute differences on a
// downscaled grayscale copy).

(function () {
  'use strict';

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // Grayscale, downscaled to `w` pixels wide. Returns {data, w, h}.
  function grayScaled(img, w) {
    const scale = w / img.width;
    const h = Math.max(1, Math.round(img.height * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, w, h);
    const rgba = x.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    for (let i = 0, p = 0; p < g.length; i += 4, p++) {
      g[p] = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114;
    }
    return { data: g, w, h };
  }

  // Mean absolute difference between the last `rows` rows of A and the
  // first `rows` rows of B.
  function bandDiff(A, B, rows) {
    const w = A.w;
    const aOff = (A.h - rows) * w;
    let sum = 0;
    const n = rows * w;
    for (let i = 0; i < n; i++) sum += Math.abs(A.data[aOff + i] - B.data[i]);
    return sum / n;
  }

  // Find how many rows of overlap join A's bottom to B's top.
  // Coarse search on a 160px-wide downscale, then a full-resolution
  // refinement pass around the coarse hit so seams land pixel-perfect.
  // Returns overlap in SOURCE-image pixels (0 = no confident match).
  function findOverlap(imgA, imgB) {
    const SCALE_W = 160;
    const A = grayScaled(imgA, SCALE_W);
    const B = grayScaled(imgB, SCALE_W);
    const maxOv = Math.floor(Math.min(A.h, B.h) * 0.9);
    const minOv = Math.max(4, Math.floor(Math.min(A.h, B.h) * 0.05));

    let bestOv = 0, bestScore = Infinity;
    for (let ov = minOv; ov <= maxOv; ov++) {
      const d = bandDiff(A, B, ov);
      // Slight bias toward larger overlaps so flat areas don't collapse
      // to the minimum.
      const score = d + 2 / ov;
      if (score < bestScore) { bestScore = score; bestOv = ov; }
    }
    // Require a decent match; typical identical bands score near 0-3,
    // unrelated content scores 20+.
    if (bestScore > 12) return 0;

    // Refine at native resolution within ±(downscale factor + 2) rows.
    const ratio = imgA.width / SCALE_W;
    const coarse = Math.round(bestOv * ratio);
    const AF = grayScaled(imgA, imgA.width);
    const BF = grayScaled(imgB, imgB.width);
    const pad = Math.ceil(ratio) + 2;
    const lo = Math.max(1, coarse - pad);
    const hi = Math.min(Math.min(AF.h, BF.h) - 1, coarse + pad);
    let best = coarse, bestD = Infinity;
    const w = AF.w;
    for (let ov = lo; ov <= hi; ov++) {
      const rows = Math.min(240, ov); // a slice of the overlap is enough
      const aOff = (AF.h - ov) * w;
      const n = rows * w;
      let sum = 0;
      for (let i = 0; i < n; i++) sum += Math.abs(AF.data[aOff + i] - BF.data[i]);
      const d = sum / n;
      if (d < bestD) { bestD = d; best = ov; }
    }
    return best;
  }

  async function stitch(dataUrls) {
    if (!dataUrls.length) throw new Error('no frames');
    const images = [];
    for (const u of dataUrls) images.push(await loadImage(u));
    if (images.length === 1) return dataUrls[0];

    const width = images[0].width;
    // y offset where each image starts in the final composite
    const offsets = [0];
    for (let i = 1; i < images.length; i++) {
      const prev = images[i - 1];
      const ov = findOverlap(prev, images[i]);
      offsets.push(offsets[i - 1] + prev.height - ov);
    }

    const totalH = Math.max(
      ...images.map((img, i) => offsets[i] + img.height)
    );
    const out = document.createElement('canvas');
    out.width = width;
    out.height = totalH;
    const ctx = out.getContext('2d');
    images.forEach((img, i) => ctx.drawImage(img, 0, offsets[i]));
    return out.toDataURL('image/png');
  }

  window.Stitcher = { stitch, findOverlap };
})();
