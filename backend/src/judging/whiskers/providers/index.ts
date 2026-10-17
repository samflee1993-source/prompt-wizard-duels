import { warnOnce, type AppConfig } from "../../../config";
import type { JudgeProvider } from "../types";
import { AnthropicViaGatewayProvider } from "./anthropic";
import { StubJudgeProvider } from "./stub";
import { WorkersAiVisionProvider } from "./workersAiVision";

/** Selects the judge from JUDGE_PROVIDER: anthropic | workers-ai | stub. */
export function createJudgeProvider(env: Env, cfg: AppConfig): JudgeProvider {
  switch (cfg.judgeProvider) {
    case "stub":
      return new StubJudgeProvider();
    case "workers-ai":
      return new WorkersAiVisionProvider(env.AI, cfg.judgeVisionModel);
    case "anthropic":
      if (env.ANTHROPIC_API_KEY) return new AnthropicViaGatewayProvider(env.ANTHROPIC_API_KEY, cfg.judgeModel, cfg.aiGatewayUrl);
      warnOnce("judge-no-key", "ANTHROPIC_API_KEY missing; judge falling back to workers-ai", { model: cfg.judgeVisionModel });
      return new WorkersAiVisionProvider(env.AI, cfg.judgeVisionModel);
    default:
      warnOnce(`judge-unknown-${cfg.judgeProvider}`, "unknown JUDGE_PROVIDER; using workers-ai", { value: cfg.judgeProvider });
      return new WorkersAiVisionProvider(env.AI, cfg.judgeVisionModel);
  }
}
