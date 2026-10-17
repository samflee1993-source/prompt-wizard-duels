// Deterministic image similarity metrics. Pure functions; all return a similarity in [0, 1].
import { resize, toGray, type RgbaImage } from "../../lib/image";

/** 64-bit difference hash: 9x8 grayscale, compare horizontal neighbours. */
export function dHash(img: RgbaImage): Uint8Array {
  const small = toGray(resize(img, 9, 8));
  const bits = new Uint8Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits[y * 8 + x] = small[y * 9 + x] > small[y * 9 + x + 1] ? 1 : 0;
  return bits;
}

export function hamming(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** 1 - hamming(dHash(a), dHash(b)) / 64. */
export function dHashSimilarity(a: RgbaImage, b: RgbaImage): number {
  return 1 - hamming(dHash(a), dHash(b)) / 64;
}

/** Per-channel normalised histograms (bins per channel), alpha composited onto white. */
export function rgbHistogram(img: RgbaImage, bins = 16): Float64Array[] {
  const h = [new Float64Array(bins), new Float64Array(bins), new Float64Array(bins)];
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const a = img.data[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) {
      const v = img.data[i * 4 + c] * a + 255 * (1 - a);
      h[c][Math.min(bins - 1, Math.floor((v / 256) * bins))]++;
    }
  }
  for (const ch of h) for (let i = 0; i < bins; i++) ch[i] /= n;
  return h;
}

/**
 * Symmetric chi-square distance between normalised histograms, averaged over R, G, B:
 * 0.5 * Σ (p - q)² / (p + q). Range [0, 1]: 0 identical, 1 disjoint.
 */
export function chiSquareDistance(a: Float64Array[], b: Float64Array[]): number {
  let total = 0;
  for (let c = 0; c < a.length; c++) {
    let d = 0;
    for (let i = 0; i < a[c].length; i++) {
      const s = a[c][i] + b[c][i];
      if (s > 0) d += ((a[c][i] - b[c][i]) ** 2) / s;
    }
    total += 0.5 * d;
  }
  return total / a.length;
}

export function histogramSimilarity(a: RgbaImage, b: RgbaImage, bins = 16): number {
  return 1 - chiSquareDistance(rgbHistogram(a, bins), rgbHistogram(b, bins));
}

/**
 * Mean SSIM over 8x8 windows (stride 4) on size x size grayscale, standard constants
 * (K1 = 0.01, K2 = 0.03, L = 255). Clamped to [0, 1] (negative SSIM counts as 0).
 */
export function ssim(a: RgbaImage, b: RgbaImage, size = 64): number {
  const ga = toGray(resize(a, size, size));
  const gb = toGray(resize(b, size, size));
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const win = 8;
  const stride = 4;
  let sum = 0;
  let count = 0;
  for (let y = 0; y + win <= size; y += stride) {
    for (let x = 0; x + win <= size; x += stride) {
      let ma = 0, mb = 0;
      for (let j = 0; j < win; j++) for (let i = 0; i < win; i++) {
        const k = (y + j) * size + x + i;
        ma += ga[k];
        mb += gb[k];
      }
      const n = win * win;
      ma /= n;
      mb /= n;
      let va = 0, vb = 0, cov = 0;
      for (let j = 0; j < win; j++) for (let i = 0; i < win; i++) {
        const k = (y + j) * size + x + i;
        const da = ga[k] - ma;
        const db = gb[k] - mb;
        va += da * da;
        vb += db * db;
        cov += da * db;
      }
      va /= n - 1;
      vb /= n - 1;
      cov /= n - 1;
      sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      count++;
    }
  }
  return Math.max(0, Math.min(1, sum / count));
}
