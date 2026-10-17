// Default image provider: FLUX.2 [klein] on Workers AI, editing the Before image with the player's prompt.
// Input images go in multipart fields input_image_0..3 and must be smaller than 512x512.
import { base64ToBytes, mimeFor, shrinkToFit, sniffFormat } from "../../lib/image";
import { runAi } from "../ai";
import type { ImageGenInput, ImageGenOutput, ImageGenProvider } from "./types";

const MAX_INPUT_SIDE = 511;

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** Output dimension: from params, else the Before's aspect at ~512px, rounded to a multiple of 16. */
function outSize(params: Record<string, unknown> | undefined, w: number, h: number): { width: number; height: number } {
  const pw = num(params?.width);
  const ph = num(params?.height);
  const r16 = (n: number) => Math.max(256, Math.min(1024, Math.round(n / 16) * 16));
  if (pw && ph) return { width: r16(pw), height: r16(ph) };
  const k = 512 / Math.max(w, h);
  return { width: r16(w * k), height: r16(h * k) };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class WorkersAiFluxProvider implements ImageGenProvider {
  readonly id = "workers-ai";

  constructor(
    private ai: Ai,
    private model: string,
  ) {}

  async generate(input: ImageGenInput): Promise<ImageGenOutput> {
    const started = Date.now();
    // Already-small Before images (the recommended authoring size) are sent as-is: no decode, no CPU.
    const before = shrinkToFit(input.beforeImage, MAX_INPUT_SIDE);
    const size = outSize(input.params, before.width, before.height);

    const form = new FormData();
    form.append("prompt", input.prompt);
    form.append("width", String(size.width));
    form.append("height", String(size.height));
    const seed = num(input.params?.seed);
    if (seed !== undefined) form.append("seed", String(Math.trunc(seed)));
    form.append("input_image_0", new Blob([before.bytes], { type: before.mime }), before.mime === "image/png" ? "before.png" : "before.jpg");

    // FormData → Response gives us the multipart body plus the boundary-bearing content type.
    const multipart = new Response(form);
    const res = await runAi(this.ai, this.model, {
      multipart: { body: multipart.body, contentType: multipart.headers.get("content-type") },
    });

    let image: Uint8Array;
    if (res instanceof ReadableStream) image = await readAll(res as ReadableStream<Uint8Array>);
    else if (res instanceof Uint8Array) image = res;
    else if (res instanceof ArrayBuffer) image = new Uint8Array(res);
    else if (res && typeof res === "object" && typeof (res as { image?: unknown }).image === "string") image = base64ToBytes((res as { image: string }).image);
    else throw new Error(`unexpected Workers AI response shape: ${Object.prototype.toString.call(res)}`);

    const fmt = sniffFormat(image);
    if (fmt !== "png" && fmt !== "jpeg") throw new Error(`Workers AI returned unsupported image format: ${fmt}`);
    return { image, meta: { provider: this.id, model: this.model, contentType: mimeFor(fmt), ms: Date.now() - started, ...size } };
  }
}
