# Challenge sets

A challenge set is a fixed sequence of rounds. Each round is a **Before** image, a **Target** image (a real AI transformation of the Before), and the facts about how the Target was made. Nothing in a round is generated at play time except the players' results.

## Folder format

One folder per set. It holds `set.json` plus the images, at any paths you like inside the folder:

```
challenges/
  stub-001/
    set.json
    r1/before.png
    r1/target.png
    r2/before.png
    ...
```

`set.json`:

```json
{
  "id": "sunset-swaps-001",
  "title": "Sunset Swaps",
  "description": "Five scenes, five skies that changed their mind.",
  "difficulty": "easy",
  "tags": ["sky", "lighting"],
  "author": "sam",
  "status": "active",
  "rounds": [
    {
      "before": "r1/before.png",
      "target": "r1/target.png",
      "originalPrompt": "same composition, background turned to a warm orange sunset, keep the yellow circle",
      "modelId": "@cf/black-forest-labs/flux-2-klein-4b",
      "modelParams": { "seed": 1234, "steps": 4, "width": 512, "height": 512 },
      "clue": "The sky grew tired of blue and borrowed the sun's last coat.",
      "tip": "Name the change, then name what must stay the same."
    }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | `^[a-z0-9][a-z0-9-]{0,62}$`. It is the R2 folder name and the D1 key, so **never reuse an id for different content**. |
| `title` | yes | 1–120 chars |
| `description`, `author` | no | Free text |
| `difficulty` | no | `easy` \| `medium` \| `hard` (default `medium`) |
| `tags` | no | Array of strings |
| `status` | no | `active` (default) or `hidden`. Hidden sets aren't listed or matched. |
| `rounds[].before` / `.target` | yes | Paths relative to the set folder. PNG or JPEG. JPEG is converted to PNG on upload. Keep them ≤ 1024 px. The default image model downsizes inputs to < 512 px. |
| `rounds[].originalPrompt` | yes | The prompt that produced the Target. Revealed in the verdict and used for keyword scoring. |
| `rounds[].modelId` | yes | Model that produced the Target |
| `rounds[].modelParams` | no | Free-form object: seed, steps, guidance, strength, size… |
| `rounds[].clue` | yes | Riddle-style hint shown during the round |
| `rounds[].tip` | yes | Prompting tip shown during the round |

A match uses the **first `ROUNDS_PER_MATCH` rounds** of a randomly chosen set that has at least that many rounds. Sets can have more rounds than a match uses.

## Where it lands

| Store | What |
|---|---|
| R2 `sets/{id}/r{n}/before.png`, `sets/{id}/r{n}/target.png` | Images (n is 1-based) |
| R2 `sets/{id}/manifest.json` | The full set in one pull: every round record plus image URLs (see CONTRACT.md §6) |
| D1 `challenge_sets` | One row per set, for paged listing and random picks |
| D1 `challenge_rounds` | One row per round |

## Loading

The loader talks to the Worker's admin API, so the same command works against `wrangler dev` and production. The Worker needs `ADMIN_TOKEN` set.

```bash
# local (npm run dev:stub sets ADMIN_TOKEN=dev-admin)
npm run load-set -- ../challenges/stub-001

# every set under a folder, against production
ADMIN_TOKEN=... npm run load-set -- ../challenges --all --api https://prompt-wizard-duels.<you>.workers.dev

# validate only
npm run load-set -- ../challenges --all --dry-run
```

Loading is idempotent:

- Each image is uploaded only if its sha256 differs from the one stored on the R2 object. `--force` re-uploads anyway.
- The set row and rounds are upserted. Rounds beyond the new count are deleted.
- When the content hash is unchanged, the D1 rows and the manifest are left alone.
- A failing set doesn't stop the others in `--all` mode. The exit code is non-zero if any set failed.

To retire a set, set `"status": "hidden"` and reload it.

## Admin API (used by the loader)

All routes require `Authorization: Bearer <ADMIN_TOKEN>` and return 404 when `ADMIN_TOKEN` is unset.

| Route | Purpose |
|---|---|
| `HEAD /admin/assets/<key>` | 200 with `x-content-sha256` if present, else 404 |
| `PUT /admin/assets/<key>` | Raw image bytes. Headers: `content-type`, `x-content-sha256`. Keys must start with `sets/`. |
| `POST /admin/decode` | Raw image bytes. Returns `{ format, width, height }` if the Worker runtime can decode it (the same decoder the objective agent uses). Handy for checking new sets. |
| `PUT /admin/sets/:setId` | Body: `SetUpsert` (see `src/challenges/schema.ts`). Checks that every image exists, writes the manifest, upserts D1. Returns `{ changed, manifestKey, manifest }`. |

## Regenerating the stub set

```bash
npm run stub:images   # rewrites challenges/stub-001 (3 rounds of 128px solid-colour shapes)
```
