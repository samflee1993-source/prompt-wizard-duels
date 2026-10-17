// Load one challenge set (or a folder of sets) into R2 + D1 through the Worker's admin API.
//
//   npm run load-set -- ../challenges/stub-001
//   npm run load-set -- ../challenges --all --api https://<worker>.workers.dev
//
// Options:
//   --api <url>     Worker base URL (default http://localhost:8787, or $PWD_API)
//   --token <t>     Admin token (default $ADMIN_TOKEN, or "dev-admin" for localhost)
//   --all           Treat <folder> as a parent: load every subfolder that has a set.json
//   --force         Re-upload images even when the stored sha256 matches
//   --dry-run       Validate and print what would happen; no network writes
//
// Idempotent: images are only uploaded when their sha256 differs from what R2 holds,
// and the set row, its rounds and manifest.json are upserted (extra old rounds are removed).
// JPEG inputs are converted to PNG so the R2 layout is always r{n}/before.png, r{n}/target.png.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateSetJson, setKeys, type SetJson, type SetUpsert } from "../src/challenges/schema.ts";
import { decodeImage, encodePng, sniffFormat } from "../src/lib/image.ts";

interface Opts {
  api: string;
  token: string;
  all: boolean;
  force: boolean;
  dryRun: boolean;
  target: string;
}

function parseArgs(argv: string[]): Opts {
  const rest: string[] = [];
  const o: Partial<Opts> = { all: false, force: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--api") o.api = argv[++i];
    else if (a === "--token") o.token = argv[++i];
    else if (a === "--all") o.all = true;
    else if (a === "--force") o.force = true;
    else if (a === "--dry-run") o.dryRun = true;
    else rest.push(a);
  }
  if (rest.length !== 1) {
    console.error("usage: load-set <folder> [--all] [--api URL] [--token T] [--force] [--dry-run]");
    process.exit(2);
  }
  const api = (o.api ?? process.env.PWD_API ?? "http://localhost:8787").replace(/\/+$/, "");
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(api);
  const token = o.token ?? process.env.ADMIN_TOKEN ?? (isLocal ? "dev-admin" : "");
  if (!token && !o.dryRun) {
    console.error("missing admin token: pass --token or set ADMIN_TOKEN");
    process.exit(2);
  }
  return { api, token, all: !!o.all, force: !!o.force, dryRun: !!o.dryRun, target: resolve(rest[0]) };
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

function readAsPng(path: string): { png: Uint8Array; width: number; height: number } {
  const raw = new Uint8Array(readFileSync(path));
  const fmt = sniffFormat(raw);
  if (fmt !== "png" && fmt !== "jpeg") throw new Error(`${path}: only PNG or JPEG supported (got ${fmt})`);
  const img = decodeImage(raw);
  if (Math.max(img.width, img.height) > 1024) console.warn(`  ! ${path} is ${img.width}x${img.height}; consider <= 1024px (FLUX.2 klein downsizes inputs to < 512px anyway)`);
  return { png: fmt === "png" ? raw : encodePng(img), width: img.width, height: img.height };
}

async function api(opts: Opts, method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) {
  const res = await fetch(`${opts.api}${path}`, { method, body, headers: { authorization: `Bearer ${opts.token}`, ...headers } });
  return res;
}

async function uploadImage(opts: Opts, key: string, png: Uint8Array): Promise<"uploaded" | "unchanged"> {
  const hash = sha256(png);
  if (!opts.force && !opts.dryRun) {
    const head = await api(opts, "HEAD", `/admin/assets/${key}`);
    if (head.status === 401 || head.status === 403) throw new Error(`admin auth failed (${head.status}); check --token`);
    if (head.ok && head.headers.get("x-content-sha256") === hash) return "unchanged";
  }
  if (opts.dryRun) return "uploaded";
  const res = await api(opts, "PUT", `/admin/assets/${key}`, png, { "content-type": "image/png", "x-content-sha256": hash });
  if (!res.ok) throw new Error(`upload ${key} failed: ${res.status} ${await res.text()}`);
  return "uploaded";
}

async function loadSet(opts: Opts, dir: string): Promise<void> {
  const setPath = join(dir, "set.json");
  const parsed = validateSetJson(JSON.parse(readFileSync(setPath, "utf8")));
  if (!parsed.ok) throw new Error(`${setPath}:\n  - ${parsed.errors.join("\n  - ")}`);
  const set: SetJson = parsed.value;
  console.log(`set ${set.id} (${set.rounds.length} rounds) from ${dir}`);

  const hashes: string[] = [];
  const rounds: SetUpsert["rounds"] = [];
  for (let i = 0; i < set.rounds.length; i++) {
    const r = set.rounds[i];
    const idx = i + 1;
    const keys = setKeys(set.id, idx);
    const before = readAsPng(join(dir, r.before));
    const target = readAsPng(join(dir, r.target));
    const sb = await uploadImage(opts, keys.before, before.png);
    const st = await uploadImage(opts, keys.target, target.png);
    console.log(`  r${idx}: before ${sb}, target ${st}`);
    hashes.push(sha256(before.png), sha256(target.png));
    rounds.push({
      index: idx,
      before: { key: keys.before, width: before.width, height: before.height },
      target: { key: keys.target, width: target.width, height: target.height },
      originalPrompt: r.originalPrompt,
      modelId: r.modelId,
      modelParams: r.modelParams ?? {},
      clue: r.clue,
      tip: r.tip,
    });
  }

  const body: SetUpsert = {
    id: set.id,
    title: set.title,
    description: set.description ?? "",
    difficulty: set.difficulty ?? "medium",
    tags: set.tags ?? [],
    author: set.author ?? "",
    status: set.status ?? "active",
    contentHash: sha256(JSON.stringify(set) + hashes.join("")),
    rounds,
  };
  if (opts.dryRun) {
    console.log(`  (dry run) would upsert set ${set.id}, contentHash ${body.contentHash.slice(0, 12)}`);
    return;
  }
  const res = await api(opts, "PUT", `/admin/sets/${set.id}`, JSON.stringify(body), { "content-type": "application/json" });
  const text = await res.text();
  if (!res.ok) throw new Error(`upsert set ${set.id} failed: ${res.status} ${text}`);
  const out = JSON.parse(text) as { changed: boolean; manifestKey: string };
  console.log(`  set row + manifest ${out.changed ? "written" : "unchanged"} (${out.manifestKey})`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dirs = opts.all
    ? readdirSync(opts.target)
        .map((d) => join(opts.target, d))
        .filter((d) => statSync(d).isDirectory() && existsSync(join(d, "set.json")))
        .sort()
    : [opts.target];
  if (dirs.length === 0) throw new Error(`no set folders found under ${opts.target}`);
  let failed = 0;
  for (const d of dirs) {
    try {
      await loadSet(opts, d);
    } catch (e) {
      failed++;
      console.error(`FAILED ${d}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`done: ${dirs.length - failed} loaded, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
