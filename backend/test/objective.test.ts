import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import rubricJson from "../config/objective-rubric.json";
import { objectiveRubric, scale, scoreObjective, validateObjectiveRubric } from "../src/judging/objective";
import { keywordOverlap, stem } from "../src/judging/objective/keywords";
import { dHashSimilarity, histogramSimilarity, ssim } from "../src/judging/objective/metrics";
import { decodeImage, encodePng, imageSize, shrinkToFit, type RgbaImage } from "../src/lib/image";

function paint(w: number, h: number, f: (x: number, y: number) => [number, number, number]): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
}

const circle = (bg: [number, number, number], fg: [number, number, number]) =>
  paint(128, 128, (x, y) => ((x - 64) ** 2 + (y - 64) ** 2 < 30 ** 2 ? fg : bg));
const BLUE_SUN = circle([40, 90, 200], [250, 210, 40]);
const ORANGE_SUN = circle([240, 120, 40], [250, 210, 40]);
const STRIPES = paint(128, 128, (x) => (Math.floor(x / 8) % 2 ? [0, 0, 0] : [255, 255, 255]));
const ORIGINAL = "same composition, background turned to a warm orange sunset, keep the yellow circle exactly as it is";

describe("objective rubric config", () => {
  it("is valid and parts sum to 50", () => {
    expect(validateObjectiveRubric(rubricJson)).toEqual([]);
    expect(objectiveRubric.parts.reduce((s, p) => s + p.max, 0)).toBe(50);
  });

  it("rejects a rubric that doesn't sum to 50", () => {
    const bad = { ...rubricJson, parts: rubricJson.parts.map((p, i) => (i === 0 ? { ...p, max: p.max + 1 } : p)) };
    expect(validateObjectiveRubric(bad).join()).toMatch(/sum to 50/);
  });

  it("scale() maps floor→0 and ceiling→max, clamped", () => {
    const p = { max: 10, floor: 0.5, ceiling: 1 };
    expect(scale(0.4, p)).toBe(0);
    expect(scale(0.75, p)).toBeCloseTo(5);
    expect(scale(1.2, p)).toBe(10);
  });
});

describe("metrics on known images", () => {
  it("identical images are perfectly similar", () => {
    expect(dHashSimilarity(BLUE_SUN, BLUE_SUN)).toBe(1);
    expect(histogramSimilarity(BLUE_SUN, BLUE_SUN)).toBeCloseTo(1, 6);
    expect(ssim(BLUE_SUN, BLUE_SUN)).toBeCloseTo(1, 6);
  });

  it("a recolored background keeps structure but loses color", () => {
    expect(dHashSimilarity(BLUE_SUN, ORANGE_SUN)).toBeGreaterThan(0.8);
    expect(histogramSimilarity(BLUE_SUN, ORANGE_SUN)).toBeLessThan(0.5);
  });

  it("unrelated images score low on structure and detail", () => {
    expect(ssim(BLUE_SUN, STRIPES)).toBeLessThan(0.3);
    expect(dHashSimilarity(ORANGE_SUN, STRIPES)).toBeLessThan(0.8);
  });
});

describe("keywords", () => {
  it("stems simple plurals and -ing/-ed", () => {
    expect(stem("sunsets")).toBe("sunset");
    expect(stem("glowing")).toBe("glow");
    expect(stem("colour")).toBe("color");
  });

  it("overlap is the share of original keywords the player used", () => {
    const stop = new Set(objectiveRubric.keywords.stopwords);
    expect(keywordOverlap(ORIGINAL, ORIGINAL, stop)).toBe(1);
    expect(keywordOverlap("make it nice", ORIGINAL, stop)).toBe(0);
    const partial = keywordOverlap("orange sunset sky", ORIGINAL, stop);
    expect(partial).toBeGreaterThan(0.2);
    expect(partial).toBeLessThan(0.6);
  });
});

describe("scoreObjective", () => {
  it("perfect match with the original prompt scores 50/50", () => {
    const s = scoreObjective({ target: ORANGE_SUN, result: ORANGE_SUN, prompt: ORIGINAL, originalPrompt: ORIGINAL });
    expect(s.total).toBe(50);
    expect(Object.keys(s.parts).sort()).toEqual(["color", "detail", "keywords", "structure"]);
    for (const p of Object.values(s.parts)) expect(p.score).toBe(p.max);
  });

  it("each part is within [0, max] and total ≤ 50 for a poor result", () => {
    const s = scoreObjective({ target: ORANGE_SUN, result: STRIPES, prompt: "stripes", originalPrompt: ORIGINAL });
    for (const p of Object.values(s.parts)) {
      expect(p.score).toBeGreaterThanOrEqual(0);
      expect(p.score).toBeLessThanOrEqual(p.max);
    }
    expect(s.total).toBeLessThan(15);
    expect(s.parts.keywords.score).toBe(0);
  });

  it("the unchanged Before scores between a perfect and a random result", () => {
    const before = scoreObjective({ target: ORANGE_SUN, result: BLUE_SUN, prompt: "orange sunset", originalPrompt: ORIGINAL }).total;
    const perfect = scoreObjective({ target: ORANGE_SUN, result: ORANGE_SUN, prompt: "orange sunset", originalPrompt: ORIGINAL }).total;
    const random = scoreObjective({ target: ORANGE_SUN, result: STRIPES, prompt: "orange sunset", originalPrompt: ORIGINAL }).total;
    expect(perfect).toBeGreaterThan(before);
    expect(before).toBeGreaterThan(random);
  });

  it("accepts encoded PNG and JPEG bytes", () => {
    const png = encodePng(ORANGE_SUN);
    const jpg = new Uint8Array(jpeg.encode({ data: Buffer.from(ORANGE_SUN.data), width: 128, height: 128 }, 95).data);
    expect(decodeImage(jpg).width).toBe(128);
    const s = scoreObjective({ target: png, result: jpg, prompt: ORIGINAL, originalPrompt: ORIGINAL });
    expect(s.total).toBeGreaterThan(45);
  });
});

describe("image header helpers", () => {
  it("reads PNG and JPEG dimensions without decoding", () => {
    const img = paint(96, 40, () => [10, 20, 30]);
    expect(imageSize(encodePng(img))).toEqual({ width: 96, height: 40 });
    const jpg = new Uint8Array(jpeg.encode({ data: Buffer.from(img.data), width: 96, height: 40 }, 80).data);
    expect(imageSize(jpg)).toEqual({ width: 96, height: 40 });
  });

  it("shrinkToFit passes small images through untouched and downsizes big ones", () => {
    const small = encodePng(paint(64, 64, () => [1, 2, 3]));
    expect(shrinkToFit(small, 512).bytes).toBe(small);
    const big = shrinkToFit(encodePng(paint(1000, 500, () => [1, 2, 3])), 511);
    expect([big.width, big.height]).toEqual([511, 256]);
  });
});
