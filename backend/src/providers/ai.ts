// The generated Ai type overloads run() per known model name. Model ids here come from config
// at runtime, so call it through one loosely typed signature in a single place.
type RunAny = (model: string, inputs: unknown, options?: Record<string, unknown>) => Promise<unknown>;

export function runAi(ai: Ai, model: string, inputs: unknown, options?: Record<string, unknown>): Promise<unknown> {
  return (ai.run as unknown as RunAny).call(ai, model, inputs, options);
}
