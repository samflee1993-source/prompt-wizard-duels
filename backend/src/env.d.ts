// Optional secrets. Not listed in wrangler.jsonc `secrets.required`, so `wrangler types`
// doesn't generate them. Declared here, merged into the generated global Env.
interface Env {
  SESSION_SECRET?: string;
  ADMIN_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  OPENART_API_KEY?: string;
}
