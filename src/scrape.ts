/**
 * Full Brand Scraper (Puppeteer + node-vibrant + colord)
 * ------------------------------------------------------
 * Implements the requirements in full:
 *  ✅ Puppeteer: headless browsing + screenshots + asset discovery + computed style extraction
 *  ✅ node-vibrant: Vibrant/Muted/Dark/Light palettes from screenshot AND key images
 *  ✅ colord: normalization + contrast checks (AA/AAA) + helper analysis
 *  ✅ Split tasks into clear pipeline stages (browse -> extract -> palette -> contrast -> report)
 *
 * Usage:
 *   npx ts-node src/scrape.ts --url https://example.com --out out
 *
 * Requires:
 *   node >= 18 (for global fetch)
 *   npm i puppeteer node-vibrant colord yargs
 *   npm i -D ts-node typescript @types/node
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";

import puppeteer, { Page } from "puppeteer";
import { Vibrant } from "node-vibrant/node";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { colord, extend } from "colord";
import * as a11yMod from "colord/plugins/a11y";

const a11yPlugin = (a11yMod as any).default ?? (a11yMod as any);
extend([a11yPlugin]);

// -----------------------------
// Types
// -----------------------------

type AssetKind = "image" | "video" | "stylesheet" | "script" | "font" | "other";

type Asset = {
  url: string;
  kind: AssetKind;
  contentType?: string;
};

type StyleSample = {
  selector: string;
  tag: string;
  text?: string;
  textColor?: string;
  backgroundColor?: string;
  borderColor?: string;
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
  backgroundImage?: string;
};

type ImageCandidate = {
  url: string;
  area: number;
  width: number;
  height: number;
  alt?: string;
};

type VibrantSwatch = {
  hex: string;
  rgb: [number, number, number];
  population: number;
};

type VibrantPalette = {
  swatches: Record<string, VibrantSwatch>;
  rankedHex: string[];
};

type ContrastCheck = {
  fg: string;
  bg: string;
  ratio: number;
  passesAA: boolean;
  passesAAA: boolean;
};

type BrandStyleSnapshot = {
  url: string;
  timestampIso: string;
  page: {
    title: string | null;
    finalUrl: string;
    viewport: { width: number; height: number };
  };
  screenshots: {
    viewportPngPath: string;
    fullPagePngPath: string;
  };
  assets: {
    discovered: Asset[];
    downloadedImages: Array<{
      sourceUrl: string;
      localPath: string;
      palette?: VibrantPalette | null;
    }>;
  };
  styles: {
    featuredSamples: StyleSample[]; // brand-significant components (header/nav/buttons/hero)
    cssStats: {
      backgroundColors: string[];
      textColors: string[];
      linkColors: string[];
      borderColors: string[];
      accentCandidates: string[];
    };
  };
  palettes: {
    fromScreenshot: VibrantPalette;
    fromImages: Record<string, VibrantPalette | null>; // by image URL
  };
  typography: {
    fontFamilies: string[];
    fontSizesPx: number[];
    fontWeights: number[];
    lineHeightsPx: number[];
  };
  contrastChecks: ContrastCheck[];
};

// -----------------------------
// Helpers
// -----------------------------

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function sha1(input: string) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

/**
 * Normalize CSS colors into HEX (e.g., rgb/rgba/hex/hsl -> #RRGGBB)
 * Returns null for invalid/transparent colors.
 */
function normalizeCssColor(input: string): string | null {
  const s = (input || "").trim();
  if (!s || s === "transparent") return null;

  const c = colord(s);
  if (!c.isValid()) return null;

  // Treat fully transparent rgba as null
  if (/rgba\(/i.test(s)) {
    const parts = s
      .replace(/^rgba\(|\)$/gi, "")
      .split(",")
      .map((x) => x.trim());
    const a = Number(parts[3]);
    if (!Number.isNaN(a) && a <= 0.01) return null;
  }

  return c.toHex().toUpperCase();
}

function paletteToReport(palette: any): VibrantPalette {
  const swatches: Record<string, VibrantSwatch> = {};

  for (const [name, sw] of Object.entries(palette)) {
    if (!sw) continue;

    const rgb = (sw as any).rgb
      ? ((sw as any).rgb as number[]).map((v) => Math.round(v))
      : [0, 0, 0];

    const rgb3 = [rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0] as [number, number, number];

    const hex =
      (typeof (sw as any).hex === "string" && (sw as any).hex) ||
      (colord(`rgb(${rgb3[0]}, ${rgb3[1]}, ${rgb3[2]})`).isValid()
        ? colord(`rgb(${rgb3[0]}, ${rgb3[1]}, ${rgb3[2]})`).toHex().toUpperCase()
        : "#000000");

    const population = typeof (sw as any).population === "number" ? (sw as any).population : 0;
    swatches[name] = { hex: hex.toUpperCase(), rgb: rgb3, population };
  }

  const rankedHex = Object.values(swatches)
    .sort((a, b) => b.population - a.population)
    .map((s) => s.hex);

  return { swatches, rankedHex };
}

async function downloadBinary(url: string, outPath: string, timeoutMs = 25000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: ac.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(outPath, buf);
  } finally {
    clearTimeout(t);
  }
}

// -----------------------------
// Stage 1: Puppeteer browsing + screenshots + asset discovery
// -----------------------------

async function collectAssetsWithPuppeteer(page: Page): Promise<Asset[]> {
  const assets = new Map<string, Asset>();

  page.on("response", async (res) => {
    try {
      const req = res.request();
      const resourceType = req.resourceType();
      const u = res.url();
      const ct = (res.headers()["content-type"] || "").toLowerCase();

      let kind: AssetKind = "other";
      if (resourceType === "image" || ct.startsWith("image/")) kind = "image";
      else if (resourceType === "media" || ct.startsWith("video/")) kind = "video";
      else if (resourceType === "stylesheet" || ct.includes("text/css")) kind = "stylesheet";
      else if (resourceType === "script" || ct.includes("javascript")) kind = "script";
      else if (ct.includes("font") || /\.(woff2?|ttf|otf)(\?|$)/i.test(u)) kind = "font";

      if (!assets.has(u)) assets.set(u, { url: u, kind, contentType: ct || undefined });
    } catch {
      // ignore noisy responses
    }
  });

  // Also do DOM-level asset discovery (catches lazy loaded + already-cached resources)
  const dom = await page.evaluate(() => {
    const abs = (u: string) => {
      try {
        return new URL(u, location.href).toString();
      } catch {
        return null;
      }
    };

    const images = Array.from(document.images)
      .map((img) => abs((img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src))
      .filter(Boolean) as string[];

    const videos = Array.from(document.querySelectorAll("video")).flatMap((v) => {
      const srcs = new Set<string>();
      const vv = v as HTMLVideoElement;
      if (vv.currentSrc) srcs.add(vv.currentSrc);
      if (vv.src) srcs.add(vv.src);
      v.querySelectorAll("source").forEach((s) => s.src && srcs.add(s.src));
      return Array.from(srcs)
        .map((u) => abs(u))
        .filter(Boolean) as string[];
    });

    const stylesheets = Array.from(document.querySelectorAll("link[rel='stylesheet']"))
      .map((l) => abs((l as HTMLLinkElement).href))
      .filter(Boolean) as string[];

    const scripts = Array.from(document.querySelectorAll("script[src]"))
      .map((s) => abs((s as HTMLScriptElement).src))
      .filter(Boolean) as string[];

    return { images, videos, stylesheets, scripts };
  });

  for (const u of dom.images) assets.set(u, { url: u, kind: "image" });
  for (const u of dom.videos) assets.set(u, { url: u, kind: "video" });
  for (const u of dom.stylesheets) assets.set(u, { url: u, kind: "stylesheet" });
  for (const u of dom.scripts) assets.set(u, { url: u, kind: "script" });

  return Array.from(assets.values());
}

async function takeScreenshots(page: Page, outDir: string) {
  const viewportPngPath = path.join(outDir, "viewport.png");
  const fullPagePngPath = path.join(outDir, "fullpage.png");

  await page.screenshot({ path: viewportPngPath, fullPage: false });
  await page.screenshot({ path: fullPagePngPath, fullPage: true });

  return { viewportPngPath, fullPagePngPath };
}

// -----------------------------
// Stage 2: Extract styles & typography using computed styles
// -----------------------------

async function extractStyleStats(page: Page) {
  const styleStats = await page.evaluate(() => {
    function isVisible(el: Element): boolean {
      const style = window.getComputedStyle(el);
      if (!style) return false;
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = (el as HTMLElement).getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    const all = Array.from(document.querySelectorAll("*")).filter(isVisible);

    // For “stats”: sample many visible nodes
    const sample = all.slice(0, 3500);

    const bg = new Map<string, number>();
    const fg = new Map<string, number>();
    const link = new Map<string, number>();
    const border = new Map<string, number>();

    const fonts = new Map<string, number>();
    const fontSizes = new Map<string, number>();
    const fontWeights = new Map<string, number>();
    const lineHeights = new Map<string, number>();

    for (const el of sample) {
      const cs = window.getComputedStyle(el);

      bg.set(cs.backgroundColor, (bg.get(cs.backgroundColor) ?? 0) + 1);
      fg.set(cs.color, (fg.get(cs.color) ?? 0) + 1);
      border.set(cs.borderTopColor, (border.get(cs.borderTopColor) ?? 0) + 1);

      if ((el as HTMLElement).tagName.toLowerCase() === "a") {
        link.set(cs.color, (link.get(cs.color) ?? 0) + 1);
      }

      fonts.set(cs.fontFamily, (fonts.get(cs.fontFamily) ?? 0) + 1);
      fontSizes.set(cs.fontSize, (fontSizes.get(cs.fontSize) ?? 0) + 1);
      fontWeights.set(cs.fontWeight, (fontWeights.get(cs.fontWeight) ?? 0) + 1);
      lineHeights.set(cs.lineHeight, (lineHeights.get(cs.lineHeight) ?? 0) + 1);
    }

    const entries = (m: Map<string, number>) => Array.from(m.entries());

    return {
      bg: entries(bg),
      fg: entries(fg),
      link: entries(link),
      border: entries(border),
      fonts: entries(fonts),
      fontSizes: entries(fontSizes),
      fontWeights: entries(fontWeights),
      lineHeights: entries(lineHeights),
    };
  });

  return styleStats as {
    bg: Array<[string, number]>;
    fg: Array<[string, number]>;
    link: Array<[string, number]>;
    border: Array<[string, number]>;
    fonts: Array<[string, number]>;
    fontSizes: Array<[string, number]>;
    fontWeights: Array<[string, number]>;
    lineHeights: Array<[string, number]>;
  };
}

async function extractFeaturedStyleSamples(page: Page): Promise<StyleSample[]> {
  // Brand-significant sampling: header/nav/buttons/hero/cta blocks + top visible sections
  const featured = await page.evaluate(() => {
    const selectors = [
      "header",
      "nav",
      "main",
      "footer",
      "button",
      "a",
      "[role='button']",
      "input[type='submit']",
      "input[type='button']",
      ".hero",
      "[class*='hero']",
      ".btn",
      "[class*='btn']",
      ".cta",
      "[class*='cta']",
    ];

    const nodes = Array.from(new Set(selectors.flatMap((s) => Array.from(document.querySelectorAll(s)))));

    const isVisible = (el: Element) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const score = (el: Element) => {
      const tag = el.tagName.toLowerCase();
      const cls = (el.getAttribute("class") || "").toLowerCase();
      const id = (el.getAttribute("id") || "").toLowerCase();
      const txt = (el.textContent || "").trim();

      const r = (el as HTMLElement).getBoundingClientRect();
      const area = r.width * r.height;

      let s = 0;
      if (tag === "header" || tag === "nav") s += 8;
      if (tag === "button") s += 7;
      if (tag === "a") s += 4;
      if (cls.includes("hero") || id.includes("hero")) s += 6;
      if (cls.includes("btn") || cls.includes("button")) s += 5;
      if (cls.includes("cta") || id.includes("cta")) s += 5;
      if (txt.length > 0 && txt.length < 60) s += 2;
      if (area > 60_000) s += 3; // large blocks often brand UI
      if (area > 200_000) s += 2;

      return s;
    };

    const toSelector = (el: Element) => {
      const id = el.getAttribute("id");
      if (id) return `#${CSS.escape(id)}`;
      const cls = (el.getAttribute("class") || "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 3)
        .map((c) => CSS.escape(c));
      const tag = el.tagName.toLowerCase();
      return cls.length ? `${tag}.${cls.join(".")}` : tag;
    };

    const picked = nodes
      .filter(isVisible)
      .map((el) => ({ el, s: score(el) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map(({ el }) => {
        const cs = getComputedStyle(el);
        const bgImg = cs.backgroundImage;

        return {
          selector: toSelector(el),
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || "").trim().slice(0, 80) || undefined,
          textColor: cs.color,
          backgroundColor: cs.backgroundColor,
          borderColor: cs.borderColor,
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          lineHeight: cs.lineHeight,
          backgroundImage: bgImg && bgImg !== "none" ? bgImg : undefined,
        };
      });

    return picked;
  });

  return featured as StyleSample[];
}

function normalizeTopColors(entries: Array<[string, number]>, take = 15) {
  const sorted = [...entries].sort((a, b) => b[1] - a[1]).slice(0, take);
  const colors: string[] = [];
  for (const [raw] of sorted) {
    const hex = normalizeCssColor(raw);
    if (hex) colors.push(hex);
  }
  return uniq(colors);
}

function topFromEntries(entries: Array<[string, number]>, take = 10) {
  return [...entries].sort((a, b) => b[1] - a[1]).slice(0, take).map(([v]) => v);
}

// -----------------------------
// Stage 3: Identify key images to analyze (hero-like images)
// -----------------------------

async function pickKeyImages(page: Page, maxImages: number): Promise<ImageCandidate[]> {
  const candidates = await page.evaluate((maxN) => {
    const abs = (u: string) => {
      try {
        return new URL(u, location.href).toString();
      } catch {
        return null;
      }
    };

    const imgs = Array.from(document.images)
      .map((img) => {
        const el = img as HTMLImageElement;
        const src = abs(el.currentSrc || el.src);
        if (!src) return null;
        const r = el.getBoundingClientRect();
        const area = Math.max(0, r.width) * Math.max(0, r.height);
        return {
          url: src,
          area: Math.round(area),
          width: Math.round(r.width),
          height: Math.round(r.height),
          alt: (el.alt || "").slice(0, 80) || undefined,
        };
      })
      .filter(Boolean) as any[];

    // Prefer large, above-the-fold-ish images
    const filtered = imgs
      .filter((x) => x.area >= 15_000)
      .sort((a, b) => b.area - a.area)
      .slice(0, maxN);

    return filtered;
  }, maxImages);

  // Deduplicate by URL
  const map = new Map<string, ImageCandidate>();
  for (const c of candidates as ImageCandidate[]) map.set(c.url, c);
  return Array.from(map.values());
}

// -----------------------------
// Stage 4: node-vibrant palettes from screenshot + images
// -----------------------------

async function vibrantFromFile(filePath: string): Promise<VibrantPalette> {
  const pal = await Vibrant.from(filePath).getPalette();
  return paletteToReport(pal);
}

async function buildPalettes(opts: {
  screenshotPath: string;
  imageCandidates: ImageCandidate[];
  imagesDir: string;
  downloadTimeoutMs: number;
  maxDownloads: number;
}) {
  const { screenshotPath, imageCandidates, imagesDir, downloadTimeoutMs, maxDownloads } = opts;

  // 1) Screenshot palette (always)
  const fromScreenshot = await vibrantFromFile(screenshotPath);

  // 2) Image palettes (download locally first)
  await ensureDir(imagesDir);

  const fromImages: Record<string, VibrantPalette | null> = {};
  const downloadedImages: Array<{ sourceUrl: string; localPath: string; palette?: VibrantPalette | null }> = [];

  const subset = imageCandidates.slice(0, maxDownloads);

  for (const img of subset) {
    const extGuess =
      img.url.match(/\.(png|jpg|jpeg|webp|gif)(\?|$)/i)?.[1]?.toLowerCase() || "bin";
    const fileName = `${sha1(img.url)}.${extGuess}`;
    const localPath = path.join(imagesDir, fileName);

    try {
      await downloadBinary(img.url, localPath, downloadTimeoutMs);
      let pal: VibrantPalette | null = null;
      try {
        pal = await vibrantFromFile(localPath);
      } catch {
        pal = null;
      }
      fromImages[img.url] = pal;
      downloadedImages.push({ sourceUrl: img.url, localPath, palette: pal });
    } catch {
      fromImages[img.url] = null;
      downloadedImages.push({ sourceUrl: img.url, localPath, palette: null });
    }
  }

  return { fromScreenshot, fromImages, downloadedImages };
}

// -----------------------------
// Stage 5: colord contrast checks
// -----------------------------

function computeContrastChecks(opts: {
  textColors: string[];
  backgroundColors: string[];
  extraPairs?: Array<{ fg: string; bg: string }>;
  maxPairs?: number;
}): ContrastCheck[] {
  const maxPairs = opts.maxPairs ?? 60;
  const fgCandidates = opts.textColors.slice(0, 10);
  const bgCandidates = opts.backgroundColors.slice(0, 10);

  const checks: ContrastCheck[] = [];

  for (const fg of fgCandidates) {
    for (const bg of bgCandidates) {
      const ratio = colord(fg).contrast(colord(bg));
      checks.push({
        fg,
        bg,
        ratio: Math.round(ratio * 100) / 100,
        passesAA: ratio >= 4.5,
        passesAAA: ratio >= 7.0,
      });
    }
  }

  if (opts.extraPairs?.length) {
    for (const p of opts.extraPairs) {
      if (!colord(p.fg).isValid() || !colord(p.bg).isValid()) continue;
      const ratio = colord(p.fg).contrast(colord(p.bg));
      checks.push({
        fg: colord(p.fg).toHex().toUpperCase(),
        bg: colord(p.bg).toHex().toUpperCase(),
        ratio: Math.round(ratio * 100) / 100,
        passesAA: ratio >= 4.5,
        passesAAA: ratio >= 7.0,
      });
    }
  }

  // Prefer high contrast AND also include failures
  const good = checks.filter((c) => c.passesAA).sort((a, b) => b.ratio - a.ratio);
  const bad = checks.filter((c) => !c.passesAA).sort((a, b) => a.ratio - b.ratio);

  return [...good.slice(0, Math.floor(maxPairs / 2)), ...bad.slice(0, Math.floor(maxPairs / 2))];
}

// -----------------------------
// Main pipeline
// -----------------------------

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option("url", { type: "string", demandOption: true, describe: "URL to scrape" })
    .option("out", { type: "string", default: "out", describe: "Output folder" })
    .option("width", { type: "number", default: 1440 })
    .option("height", { type: "number", default: 900 })
    .option("timeoutMs", { type: "number", default: 60_000 })
    .option("waitUntil", {
      type: "string",
      default: "networkidle2",
      choices: ["load", "domcontentloaded", "networkidle0", "networkidle2"] as const,
    })
    .option("maxImages", { type: "number", default: 8, describe: "Max key images to analyze via node-vibrant" })
    .option("downloadTimeoutMs", { type: "number", default: 25_000 })
    .option("headless", { type: "boolean", default: true })
    .help()
    .parse();

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const url = argv.url;
  const outRoot = path.resolve(__dirname, "..", argv.out);
  await ensureDir(outRoot);

  // Site-scoped dir (keeps runs clean)
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/[:]/g, "_");
    } catch {
      return "site";
    }
  })();
  const runDir = path.join(outRoot, host, String(Date.now()));
  const imagesDir = path.join(runDir, "images");
  await ensureDir(runDir);

  const browser = await puppeteer.launch({
  headless: argv.headless, // boolean
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    // -----------------------------
    // Puppeteer stage
    // -----------------------------
    const page = await browser.newPage();
    await page.setViewport({ width: argv.width, height: argv.height });
    page.setDefaultNavigationTimeout(argv.timeoutMs);

    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36"
    );

    // Asset capture listener
    const assetPromise = collectAssetsWithPuppeteer(page);

    const resp = await page.goto(url, { waitUntil: argv.waitUntil as any });
    if (!resp) throw new Error("Navigation failed: no response");
    const finalUrl = page.url();

    // Best-effort cookie accept to reduce overlay distortion
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a")) as HTMLElement[];
      const hit = btns.find((b) => /accept|agree|ok|got it|allow all/i.test((b.textContent || "").trim()));
      hit?.click?.();
    });

    await sleep(900);
    const title = await page.title().catch(() => null);

    const discoveredAssets = await assetPromise;

    // Screenshots
    const screenshots = await takeScreenshots(page, runDir);

    // -----------------------------
    // Style extraction stage
    // -----------------------------
    const styleStats = await extractStyleStats(page);
    const featuredSamples = await extractFeaturedStyleSamples(page);

    const backgroundColors = normalizeTopColors(styleStats.bg, 25);
    const textColors = normalizeTopColors(styleStats.fg, 25);
    const linkColors = normalizeTopColors(styleStats.link, 18);
    const borderColors = normalizeTopColors(styleStats.border, 18);

    // Accent candidates (remove near-grays)
    const accentCandidates = uniq(
      [...linkColors, ...textColors.slice(0, 8)].filter((hex) => {
        const c = colord(hex);
        if (!c.isValid()) return false;
        const { r, g, b } = c.toRgb();
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        return max - min > 18;
      })
    ).slice(0, 14);

    // Typography stats
    const fontFamilies = uniq(topFromEntries(styleStats.fonts, 14));
    const fontSizesPx = uniq(
      topFromEntries(styleStats.fontSizes, 14)
        .map((s) => Number(String(s).replace("px", "")))
        .filter((n) => Number.isFinite(n))
    ).sort((a, b) => a - b);

    const fontWeights = uniq(
      topFromEntries(styleStats.fontWeights, 14)
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n))
    ).sort((a, b) => a - b);

    const lineHeightsPx = uniq(
      topFromEntries(styleStats.lineHeights, 14)
        .map((s) => Number(String(s).replace("px", "")))
        .filter((n) => Number.isFinite(n))
    ).sort((a, b) => a - b);

    // -----------------------------
    // Key image selection stage
    // -----------------------------
    const imageCandidates = await pickKeyImages(page, argv.maxImages);

    // -----------------------------
    // node-vibrant palette stage
    // -----------------------------
    const palettes = await buildPalettes({
      screenshotPath: screenshots.fullPagePngPath,
      imageCandidates,
      imagesDir,
      downloadTimeoutMs: argv.downloadTimeoutMs,
      maxDownloads: argv.maxImages,
    });

    // -----------------------------
    // colord contrast stage
    // Use both css colors and top vibrant swatches as extra candidates
    // -----------------------------
    const extraPairs: Array<{ fg: string; bg: string }> = [];
    for (const fg of palettes.fromScreenshot.rankedHex.slice(0, 6)) {
      for (const bg of backgroundColors.slice(0, 6)) {
        extraPairs.push({ fg, bg });
      }
    }

    const contrastChecks = computeContrastChecks({
      textColors,
      backgroundColors,
      extraPairs,
      maxPairs: 60,
    });

    // -----------------------------
    // Build report
    // -----------------------------
    const report: BrandStyleSnapshot = {
      url,
      timestampIso: new Date().toISOString(),
      page: {
        title,
        finalUrl,
        viewport: { width: argv.width, height: argv.height },
      },
      screenshots,
      assets: {
        discovered: discoveredAssets,
        downloadedImages: palettes.downloadedImages,
      },
      styles: {
        featuredSamples,
        cssStats: {
          backgroundColors,
          textColors,
          linkColors,
          borderColors,
          accentCandidates,
        },
      },
      palettes: {
        fromScreenshot: palettes.fromScreenshot,
        fromImages: palettes.fromImages,
      },
      typography: {
        fontFamilies,
        fontSizesPx,
        fontWeights,
        lineHeightsPx,
      },
      contrastChecks,
    };

    const reportPath = path.join(runDir, "report.json");
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

    console.log("Done ✅");
    console.log("Run dir:", runDir);
    console.log("Report:", reportPath);
    console.log("Viewport screenshot:", screenshots.viewportPngPath);
    console.log("Fullpage screenshot:", screenshots.fullPagePngPath);
    console.log("Images downloaded:", palettes.downloadedImages.length);
    console.log("Assets discovered:", discoveredAssets.length);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
