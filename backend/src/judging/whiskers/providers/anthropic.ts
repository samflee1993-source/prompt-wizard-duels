// Claude (Haiku-class by default) through Cloudflare AI Gateway, with structured JSON output.
import Anthropic from "@anthropic-ai/sdk";
import { bytesToBase64, decodeImage, encodePng, fitWithin } from "../../../lib/image";
import type { Slot } from "../../../protocol";
import { extractJson, judgeInstructions, judgeOutputSchema, type JudgeInput, type JudgeProvider } from "../types";

/** Judges don't need full resolution; 512px keeps tokens (and cost) down. */
export function judgeImagePng(bytes: Uint8Array, maxSide = 512): Uint8Array {
  return encodePng(fitWithin(decodeImage(bytes), maxSide));
}

export class AnthropicViaGatewayProvider implements JudgeProvider {
  readonly id = "anthropic";
  private client: Anthropic;

  constructor(
    apiKey: string,
    private model: string,
    gatewayUrl: string,
  ) {
    // AI Gateway: https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic
    const baseURL = gatewayUrl ? `${gatewayUrl.replace(/\/+$/, "")}/anthropic` : undefined;
    this.client = new Anthropic({ apiKey, baseURL, maxRetries: 1, timeout: 60_000 });
  }

  async judge(input: JudgeInput): Promise<unknown> {
    const slots = (["A", "B"] as Slot[]).filter((s) => (s === "A" ? input.resultA : input.resultB) !== null);
    const images = [input.before, input.target, ...slots.map((s) => (s === "A" ? input.resultA : input.resultB))].filter(
      (b): b is Uint8Array => !!b,
    );
    const content: Anthropic.ContentBlockParam[] = images.map((b) => ({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: bytesToBase64(judgeImagePng(b)) },
    }));
    content.push({ type: "text", text: judgeInstructions(input, slots) });

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 4000,
      system: input.teacher.systemPrompt,
      // Strict JSON via structured outputs; low effort keeps a fast, cheap judge.
      output_config: { effort: "low", format: { type: "json_schema", schema: judgeOutputSchema(input.teacher, slots) } },
      messages: [{ role: "user", content }],
    });
    if (res.stop_reason === "refusal") throw new Error("judge refused");
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return extractJson(text);
  }
}
