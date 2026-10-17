// Keyword overlap between a player's prompt and the original prompt. Pure, deterministic.

/** Very small stemmer: enough to match sunset/sunsets, glowing/glow, colored/color. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("es") && /(ss|x|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  // colour → color, grey → gray
  return w.replace(/our$/, "or").replace(/^grey$/, "gray");
}

export function keywords(text: string, stopwords: Set<string>, minLength: number): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/)) {
    if (raw.length < minLength || stopwords.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

/** Share of the original prompt's keywords that the player's prompt also contains, in [0, 1]. */
export function keywordOverlap(playerPrompt: string, originalPrompt: string, stopwords: Set<string>, minLength = 3): number {
  const target = keywords(originalPrompt, stopwords, minLength);
  if (target.size === 0) return 0;
  const mine = keywords(playerPrompt, stopwords, minLength);
  let hit = 0;
  for (const k of target) if (mine.has(k)) hit++;
  return hit / target.size;
}
