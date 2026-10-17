// Test/keyless provider: returns a recolored copy of the Before image. Deterministic per prompt.
// Set params.stubFail = N to make the first N calls fail (exercises retry/void in tests).
import { decodeImage, encodePng } from "../../lib/image";
import type { ImageGenInput, ImageGenOutput, ImageGenProvider } from "./types";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

export class StubImageGenProvider implements ImageGenProvider {
  readonly id = "stub";
  private calls = 0;

  async generate(input: ImageGenInput): Promise<ImageGenOutput> {
    const started = Date.now();
    this.calls++;
    const failN = Number(input.params?.stubFail ?? 0);
    if (failN > 0 && this.calls <= failN) throw new Error(`stub failure ${this.calls}/${failN}`);
    if (/\bSTUB_FAIL\b/.test(input.prompt)) throw new Error("stub failure requested by prompt");

    const img = decodeImage(input.beforeImage);
    const h = hash(input.prompt.trim().toLowerCase());
    const perm = [[0, 1, 2], [1, 2, 0], [2, 0, 1], [0, 2, 1], [2, 1, 0], [1, 0, 2]][h % 6];
    const tint = [(h >>> 4) & 63, (h >>> 10) & 63, (h >>> 16) & 63];
    const strength = 0.25 + ((h >>> 22) % 50) / 100; // 0.25..0.74
    const out = new Uint8Array(img.data.length);
    for (let i = 0; i < img.data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const src = img.data[i + perm[c]];
        out[i + c] = Math.min(255, Math.round(src * (1 - strength) + img.data[i + c] * strength * 0.6 + tint[c]));
      }
      out[i + 3] = img.data[i + 3];
    }
    const image = encodePng({ width: img.width, height: img.height, data: out });
    return { image, meta: { provider: this.id, model: "stub/recolor", contentType: "image/png", ms: Date.now() - started } };
  }
}
