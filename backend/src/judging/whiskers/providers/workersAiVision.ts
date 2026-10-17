// Free fallback judge: a Workers AI vision model (default Llama 4 Scout) through the AI binding.
// TODO-verify: multi-image input and json_schema response_format support vary by model; this
// sends all images as data URLs and also asks for JSON in the prompt, so a model that ignores
// response_format still usually works. The pipeline retries once and then falls back to 25/50.
import type { Slot } from "../../../protocol";
import { extractJson, judgeInstructions, judgeOutputSchema, type JudgeInput, type JudgeProvider } from "../types";
import { judgeImage } from "./anthropic";
import { runAi } from "../../../providers/ai";

export class WorkersAiVisionProvider implements JudgeProvider {
  readonly id = "workers-ai";

  constructor(
    private ai: Ai,
    private model: string,
  ) {}

  async judge(input: JudgeInput): Promise<unknown> {
    const slots = (["A", "B"] as Slot[]).filter((s) => (s === "A" ? input.resultA : input.resultB) !== null);
    const images = [input.before, input.target, ...slots.map((s) => (s === "A" ? input.resultA : input.resultB))].filter(
      (b): b is Uint8Array => !!b,
    );
    const res = (await runAi(this.ai, this.model, {
      messages: [
        { role: "system", content: input.teacher.systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: judgeInstructions(input, slots) },
            ...images.map((b) => {
              const img = judgeImage(b, 384);
              return { type: "image_url", image_url: { url: `data:${img.mime};base64,${img.data}` } };
            }),
          ],
        },
      ],
      max_tokens: 1200,
      temperature: 0.4,
      response_format: { type: "json_schema", json_schema: judgeOutputSchema(input.teacher, slots) },
    })) as { response?: unknown };
    const r = res?.response;
    if (r && typeof r === "object") return r;
    if (typeof r === "string") return extractJson(r);
    throw new Error("workers-ai judge returned no response");
  }
}
