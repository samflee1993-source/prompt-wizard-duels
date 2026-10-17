import { defineConfig } from "vitest/config";

// Unit tests for the pure modules (rules, scoring, teachers, matchmaking) run in Node.
// The Workers runtime paths are exercised end to end by test/play-match.ts against `wrangler dev`.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
