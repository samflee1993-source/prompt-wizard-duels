// OpenArt adapter. We don't have OpenArt's API docs, so this targets a plausible REST shape.
// Everything that depends on their real API is marked TODO-verify and lives in this file only.
import { base64ToBytes, bytesToBase64, decodeImage, encodePng, fitWithin, mimeFor, sniffFormat } from "../../lib/image";
import type { ImageGenInput, ImageGenOutput, ImageGenProvider } from "./types";

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 90_000;

// TODO-verify: request body shape for an image-to-image / edit generation.
interface OpenArtGenerateRequest {
  model: string;
  prompt: string;
  image: string; // data URL of the Before image
  num_images: 1;
  seed?: number;
  width?: number;
  height?: number;
}

// TODO-verify: response shape. Handles both a synchronous result and an async job to poll.
interface OpenArtGenerateResponse {
  id?: string;
  status?: "queued" | "processing" | "succeeded" | "failed" | string;
  error?: string;
  data?: Array<{ url?: string; b64_json?: string }>;
  images?: Array<{ url?: string; b64_json?: string }>;
}

export class OpenArtProvider implements ImageGenProvider {
  readonly id = "openart";

  constructor(
    private apiKey: string,
    private baseUrl: string,
    private model = "flux-kontext", // TODO-verify: OpenArt model identifier
  ) {}

  async generate(input: ImageGenInput): Promise<ImageGenOutput> {
    const started = Date.now();
    const before = encodePng(fitWithin(decodeImage(input.beforeImage), 1024));
    const p = input.params ?? {};
    const body: OpenArtGenerateRequest = {
      model: typeof p.openartModel === "string" ? p.openartModel : this.model,
      prompt: input.prompt,
      image: `data:image/png;base64,${bytesToBase64(before)}`,
      num_images: 1,
      ...(typeof p.seed === "number" ? { seed: p.seed } : {}),
      ...(typeof p.width === "number" ? { width: p.width } : {}),
      ...(typeof p.height === "number" ? { height: p.height } : {}),
    };

    // TODO-verify: endpoint path and auth header.
    let res = await this.call("POST", "/generations", body);
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (!this.firstImage(res) && res.id && res.status !== "failed" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      res = await this.call("GET", `/generations/${encodeURIComponent(res.id)}`); // TODO-verify: poll path
    }
    if (res.status === "failed") throw new Error(`OpenArt generation failed: ${res.error ?? "unknown error"}`);
    const first = this.firstImage(res);
    if (!first) throw new Error("OpenArt returned no image (timed out or unexpected shape)");

    const image = first.b64_json ? base64ToBytes(first.b64_json) : await this.download(first.url!);
    const fmt = sniffFormat(image);
    if (fmt !== "png" && fmt !== "jpeg") throw new Error(`OpenArt returned unsupported image format: ${fmt}`);
    return { image, meta: { provider: this.id, model: body.model, contentType: mimeFor(fmt), ms: Date.now() - started, jobId: res.id } };
  }

  private firstImage(r: OpenArtGenerateResponse): { url?: string; b64_json?: string } | undefined {
    return (r.data ?? r.images ?? []).find((i) => i.url || i.b64_json);
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<OpenArtGenerateResponse> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OpenArt ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as OpenArtGenerateResponse;
  }

  private async download(url: string): Promise<Uint8Array> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OpenArt image download failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
