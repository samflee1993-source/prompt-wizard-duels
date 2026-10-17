import { warnOnce, type AppConfig } from "../../config";
import { OpenArtProvider } from "./openArt";
import { StubImageGenProvider } from "./stub";
import type { ImageGenProvider } from "./types";
import { WorkersAiFluxProvider } from "./workersAiFlux";

export type { ImageGenProvider, ImageGenInput, ImageGenOutput } from "./types";

/** Selects the image provider from IMAGE_GEN_PROVIDER: workers-ai | openart | stub. */
export function createImageGenProvider(env: Env, cfg: AppConfig): ImageGenProvider {
  switch (cfg.imageGenProvider) {
    case "stub":
      return new StubImageGenProvider();
    case "openart":
      if (env.OPENART_API_KEY) return new OpenArtProvider(env.OPENART_API_KEY, cfg.openArtBaseUrl);
      warnOnce("openart-no-key", "OPENART_API_KEY missing; image generation falling back to workers-ai", { model: cfg.imageGenModel });
      return new WorkersAiFluxProvider(env.AI, cfg.imageGenModel);
    case "workers-ai":
      return new WorkersAiFluxProvider(env.AI, cfg.imageGenModel);
    default:
      warnOnce(`imagegen-unknown-${cfg.imageGenProvider}`, "unknown IMAGE_GEN_PROVIDER; using workers-ai", { value: cfg.imageGenProvider });
      return new WorkersAiFluxProvider(env.AI, cfg.imageGenModel);
  }
}
