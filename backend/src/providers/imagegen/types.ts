export interface ImageGenInput {
  /** The round's Before image (PNG or JPEG bytes). */
  beforeImage: Uint8Array;
  /** The player's prompt, verbatim. */
  prompt: string;
  /** The set round's modelParams (seed, steps, width, height...). Providers use what they understand. */
  params?: Record<string, unknown>;
}

export interface ImageGenOutput {
  image: Uint8Array;
  meta: {
    provider: string;
    model: string;
    contentType: string; // image/png | image/jpeg
    ms: number;
    [k: string]: unknown;
  };
}

export interface ImageGenProvider {
  readonly id: string;
  generate(input: ImageGenInput): Promise<ImageGenOutput>;
}
