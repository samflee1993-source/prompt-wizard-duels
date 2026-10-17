// Pure-JS image helpers: decode PNG/JPEG, resize, grayscale, encode PNG.
// Works in workerd and in Node (scripts, vitest). No WASM, no native deps.
import { convertIndexedToRgb, decode as decodePngRaw, encode as encodePngRaw } from "fast-png";
import jpeg from "jpeg-js";

/** 8-bit RGBA pixels, row-major. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array; // length = width * height * 4
}

export type ImageFormat = "png" | "jpeg" | "webp" | "unknown";

export function sniffFormat(bytes: Uint8Array): ImageFormat {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  )
    return "webp";
  return "unknown";
}

export function mimeFor(format: ImageFormat): string {
  return format === "png" ? "image/png" : format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "application/octet-stream";
}

export function decodeImage(bytes: Uint8Array): RgbaImage {
  const format = sniffFormat(bytes);
  if (format === "png") return decodePng(bytes);
  if (format === "jpeg") {
    const out = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 });
    return { width: out.width, height: out.height, data: new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength) };
  }
  throw new Error(`unsupported image format: ${format}`);
}

function decodePng(bytes: Uint8Array): RgbaImage {
  const png = decodePngRaw(bytes);
  const { width, height } = png;
  const n = width * height;
  const out = new Uint8Array(n * 4);
  let src: ArrayLike<number> = png.data;
  let ch = png.channels;
  let depth: number = png.depth;
  if (png.palette) {
    src = convertIndexedToRgb(png);
    ch = src.length / n;
    depth = 8;
  }
  const scale = depth === 16 ? 1 / 257 : 1;
  for (let i = 0; i < n; i++) {
    const s = i * ch;
    let r: number, g: number, b: number, a: number;
    if (ch === 1) {
      r = g = b = src[s] * scale;
      a = 255;
    } else if (ch === 2) {
      r = g = b = src[s] * scale;
      a = src[s + 1] * scale;
    } else {
      r = src[s] * scale;
      g = src[s + 1] * scale;
      b = src[s + 2] * scale;
      a = ch === 4 ? src[s + 3] * scale : 255;
    }
    if (depth < 8 && ch === 1) {
      // fast-png returns unscaled sub-byte gray values; stretch to 0..255.
      const max = (1 << depth) - 1;
      r = g = b = (src[s] / max) * 255;
    }
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  }
  return { width, height, data: out };
}

export function encodePng(img: RgbaImage): Uint8Array {
  return encodePngRaw({ width: img.width, height: img.height, data: img.data, channels: 4, depth: 8 });
}

/** Area-averaging resize (good for downscaling), bilinear-ish for upscaling. Alpha is composited onto white. */
export function resize(img: RgbaImage, width: number, height: number): RgbaImage {
  const out = new Uint8Array(width * height * 4);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = y * sy;
    const y1 = Math.max(y0 + 1e-9, (y + 1) * sy);
    for (let x = 0; x < width; x++) {
      const x0 = x * sx;
      const x1 = Math.max(x0 + 1e-9, (x + 1) * sx);
      let r = 0, g = 0, b = 0, wsum = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        if (wy <= 0) continue;
        const ry = Math.min(yy, img.height - 1);
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          if (wx <= 0) continue;
          const rx = Math.min(xx, img.width - 1);
          const i = (ry * img.width + rx) * 4;
          const a = img.data[i + 3] / 255;
          const w = wx * wy;
          r += (img.data[i] * a + 255 * (1 - a)) * w;
          g += (img.data[i + 1] * a + 255 * (1 - a)) * w;
          b += (img.data[i + 2] * a + 255 * (1 - a)) * w;
          wsum += w;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = Math.round(r / wsum);
      out[o + 1] = Math.round(g / wsum);
      out[o + 2] = Math.round(b / wsum);
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/** Fit inside maxSide x maxSide, keeping aspect ratio. Returns the input when already small enough. */
export function fitWithin(img: RgbaImage, maxSide: number): RgbaImage {
  const side = Math.max(img.width, img.height);
  if (side <= maxSide) return img;
  const k = maxSide / side;
  return resize(img, Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k)));
}

/** Rec. 601 luma, 0..255, one value per pixel. */
export function toGray(img: RgbaImage): Float64Array {
  const n = img.width * img.height;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = img.data[i * 4 + 3] / 255;
    const r = img.data[i * 4] * a + 255 * (1 - a);
    const g = img.data[i * 4 + 1] * a + 255 * (1 - a);
    const b = img.data[i * 4 + 2] * a + 255 * (1 - a);
    out[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:[^,]*,/, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
