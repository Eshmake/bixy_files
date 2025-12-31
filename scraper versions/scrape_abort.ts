// src/scrape.ts
// Brand Scraper v4 (fixes filename collisions + filters tracking pixels + better brand image picks)
// Usage:
//   npm run dev -- --url "https://vivint.com" --out out --timeoutMs 45000
//
// Optional (recommended) for better WebP palette extraction:
//   npm i sharp

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import puppeteer, { type Page } from "puppeteer";
import { Vibrant } from "node-vibrant/node";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { colord, extend } from "colord";
import * as a11yMod from "colord/plugins/a11y";
const a11yPlugin = (a11yMod as any).default ?? (a11yMod as any);
extend([a11yPlugin]);

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

type Swatch = { hex: string; rgb: [number, number, number]; population: number };

type BrandStyleSnapshot = {
  url: string;
  timestampIso: string;
  page: {
    title: string | null;
    finalUrl: string;
    viewport: { width: number; height: number };
    notes?: string[];
  };
  colors: {
    extractedFromScreenshot: {
      swatches: Record<string, Swatch>;
      rankedHex: string[];
    };
    css: {
      backgroundColors: string[];
      textColors: string[];
      linkColors: string[];
      borderColors: string[];
      accentCandidates: string[];
    };
  };
  palettes: {
    fromScreenshot: {
      swatches: Record<string, Swatch>;
      rankedHex: string[];
    };
    fromImages: Record<
      string,
      | null
      | {
          swatches: Record<string, Swatch>;
          rankedHex: string[];
          downloadedPath?: string;
        }
    >;
  };
  typography: {
    fontFamilies: string[];
    fontSizesPx: number[];
    fontWeights: number[];
    lineHeightsPx: number[];
  };
  contrastChecks: Array<{
    fg: string;
    bg: string;
    ratio: number;
    passesAA: boolean;
    passesAAA: boolean;
  }>;
  assets: {
    screenshotPath: string;
    outputDir: string;

    images: string[];
    brandImages: string[];
    trackingPixels: string[];

    videos: string[];
    stylesheets: string[];
    scripts: string[];
    fonts: string[];

    downloadedImagePaths: Array<{ url: string; path: string; ok: boolean; reason?: string; contentType?: string }>;

    debugHtmlPath?: string;
    debugScreenshotPath?: string;
  };
};

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function normalizeCssColor(input: string): string | null {
  const s = (input || "").trim();
  if (!s || s === "transparent") return null;

  const c = colord(s);
  if (!c.isValid()) return null;

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

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function sha256(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function isHttpUrl(u: string) {
  return /^https?:\/\//i.test(u);
}
function isDataUrl(u: string) {
  return /^data:/i.test(u);
}
function looksLikeSvg(u: string) {
  return /\.svg(\?.*)?$/i.test(u);
}
function looksLikeVideoUrl(u: string) {
  return /\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(u);
}

function extFromContentType(ct: string | null): string | null {
  if (!ct) return null;
  const x = ct.toLowerCase().split(";")[0].trim();
  if (x === "image/png") return ".png";
  if (x === "image/jpeg") return ".jpg";
  if (x === "image/jpg") return ".jpg";
  if (x === "image/webp") return ".webp";
  if (x === "image/gif") return ".gif";
  if (x === "image/avif") return ".avif";
  if (x === "image/bmp") return ".bmp";
  if (x === "image/x-icon" || x === "image/vnd.microsoft.icon") return ".ico";
  if (x === "image/svg+xml") return ".svg";
  return null;
}

/** Much stronger tracking pixel / beacon detection. */
function isTrackingPixelUrl(u: string) {
  const x = u.toLowerCase();

  // explicit endpoints we saw in your report
  if (x.includes("t.co/i/adsct") || x.includes("analytics.twitter.com/i/adsct")) return true;
  if (x.includes("ib.adnxs.com/setuid")) return true;

  // common beacon keywords
  const keywords = [
    "pixel",
    "beacon",
    "collect",
    "conversion",
    "viewthrough",
    "adsct",
    "setuid",
    "track",
    "tracking",
    "analytics",
    "gtag",
  ];
  const badHosts = [
    "doubleclick.net",
    "googleadservices.com",
    "googlesyndication.com",
    "googletagmanager.com",
    "google-analytics.com",
    "analytics.twitter.com",
    "t.co",
    "ib.adnxs.com",
    "bat.bing.com",
    "connect.facebook.net",
    "facebook.com/tr",
    "snap.licdn.com",
    "px.ads.linkedin.com",
    "hotjar.com",
    "tiktok.com",
    "ads-twitter.com",
    "redditstatic.com/ads",
    "criteo.com",
    "taboola.com",
    "mgid.com",
    "adserver.",
  ];

  if (badHosts.some((h) => x.includes(h))) return true;

  // query-heavy GIFs are often 1x1 trackers
  if (x.endsWith(".gif") && x.includes("?") && keywords.some((k) => x.includes(k))) return true;

  // generic: if URL contains pixel/beacon-style keywords AND has lots of query params
  if (keywords.some((k) => x.includes(k))) {
    const q = x.split("?")[1] || "";
    if (q.length > 60) return true;
  }

  return false;
}

/** Detect common bot challenge pages and fail fast. */
async function detectHumanVerification(page: Page): Promise<string | null> {
  const url = page.url();

  const urlHints = ["captcha", "challenge", "cf_chl", "cloudflare", "verify", "turnstile", "recaptcha"];
  if (urlHints.some((h) => url.toLowerCase().includes(h))) {
    return `URL looks like a challenge page: ${url}`;
  }

  const reason = await page.evaluate(() => {
    const text = (document.body?.innerText || "").toLowerCase();

    const textHits = [
      "verify you are human",
      "verify you're human",
      "checking your browser",
      "enable javascript and cookies",
      "one more step",
      "attention required",
      "captcha",
      "press and hold",
    ];
    if (textHits.some((t) => text.includes(t))) {
      return "Page text indicates a bot/human verification interstitial.";
    }

    const cf = document.querySelector(
      'iframe[src*="challenges.cloudflare.com"], iframe[id*="cf-chl"], #cf-challenge, .cf-challenge, [data-sitekey][data-callback]'
    );
    if (cf) return "Detected Cloudflare/Turnstile challenge elements.";

    const rc = document.querySelector('iframe[src*="google.com/recaptcha"], .g-recaptcha, [data-sitekey]');
    if (rc) return "Detected reCAPTCHA elements.";

    return null;
  });

  return reason;
}

/** Cookie/consent dismiss (top + iframes). Best-effort heuristics. */
async function dismissCookieBanners(page: Page): Promise<boolean> {
  let clicked = false;

  const tryClickDoc = async () => {
    return await page.evaluate(() => {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
      const good = [
        "accept",
        "accept all",
        "accept cookies",
        "i accept",
        "agree",
        "i agree",
        "allow all",
        "allow",
        "ok",
        "okay",
        "got it",
        "continue",
      ];

      const badWords = ["reject", "manage", "preferences", "settings", "necessary", "decline"];

      const isVisible = (el: Element) => {
        const st = window.getComputedStyle(el);
        if (!st) return false;
        if (st.display === "none" || st.visibility === "hidden") return false;
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      const candidates: Element[] = [];
      const selectors = ["button", "a[role='button']", "input[type='button']", "input[type='submit']", "[aria-label]"];
      for (const sel of selectors) document.querySelectorAll(sel).forEach((el) => candidates.push(el));

      for (const el of candidates) {
        if (!isVisible(el)) continue;

        const text = norm((el as HTMLElement).innerText || "");
        const aria = norm(el.getAttribute("aria-label") || "");
        const val = norm((el as HTMLInputElement).value || "");
        const combined = [text, aria, val].filter(Boolean).join(" ");

        if (badWords.some((w) => combined.includes(w))) continue;

        const isGood =
          good.includes(combined) ||
          good.includes(text) ||
          good.includes(aria) ||
          good.includes(val) ||
          combined.includes("accept all") ||
          combined === "accept" ||
          combined === "agree" ||
          combined === "ok" ||
          combined === "okay";

        if (isGood) {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    });
  };

  const tryClickFrames = async () => {
    let didAny = false;
    for (const frame of page.frames()) {
      try {
        const did = await frame.evaluate(() => {
          const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
          const isVisible = (el: Element) => {
            const st = window.getComputedStyle(el);
            if (!st) return false;
            if (st.display === "none" || st.visibility === "hidden") return false;
            const r = (el as HTMLElement).getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };

          const btns = Array.from(
            document.querySelectorAll("button, a[role='button'], input[type='button'], input[type='submit']")
          );

          for (const el of btns) {
            if (!isVisible(el)) continue;
            const text = norm((el as HTMLElement).innerText || (el as HTMLInputElement).value || "");
            if (text.includes("accept") && !text.includes("reject") && !text.includes("manage")) {
              (el as HTMLElement).click();
              return true;
            }
            if (text === "agree" || text === "ok" || text === "okay") {
              (el as HTMLElement).click();
              return true;
            }
          }
          return false;
        });
        if (did) didAny = true;
      } catch {
        // ignore cross-origin frame errors
      }
    }
    return didAny;
  };

  for (let i = 0; i < 4; i++) {
    const a = await tryClickDoc();
    const b = await tryClickFrames();
    if (a || b) {
      clicked = true;
      await sleep(500);
    } else {
      await sleep(350);
    }
  }

  return clicked;
}

/** Navigate without hanging forever on networkidle. */
async function safeGoto(page: Page, url: string, timeoutMs: number) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await sleep(600);

  await dismissCookieBanners(page);

  const v1 = await detectHumanVerification(page);
  if (v1) throw new Error(`HUMAN_VERIFICATION: ${v1}`);

  await sleep(900);

  await dismissCookieBanners(page);

  const v2 = await detectHumanVerification(page);
  if (v2) throw new Error(`HUMAN_VERIFICATION: ${v2}`);
}

function paletteToSwatches(palette: any): { swatches: Record<string, Swatch>; rankedHex: string[] } {
  const swatches: Record<string, Swatch> = {};
  for (const [name, sw] of Object.entries(palette ?? {})) {
    if (!sw) continue;
    const rgb = ((sw as any).rgb ?? [0, 0, 0]).map((v: number) => Math.round(v)) as [number, number, number];
    const hex =
      (typeof (sw as any).hex === "string" && (sw as any).hex) ||
      (colord(`rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`).isValid()
        ? colord(`rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`).toHex().toUpperCase()
        : "#000000");
    const population = typeof (sw as any).population === "number" ? (sw as any).population : 0;
    swatches[name] = { hex: hex.toUpperCase(), rgb, population };
  }

  const rankedHex = Object.values(swatches)
    .sort((a, b) => b.population - a.population)
    .map((s) => s.hex);

  return { swatches, rankedHex };
}

/** Download an image and return final path + content-type. Uses sha256 filename to avoid collisions. */
async function downloadImageUnique(
  url: string,
  outDir: string,
  timeoutMs: number
): Promise<{ ok: boolean; path?: string; reason?: string; contentType?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: url,
      },
    });

    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.startsWith("image/")) return { ok: false, reason: `Not an image content-type: ${ct || "unknown"}` };

    const ext = extFromContentType(ct);
    if (ext === ".svg") return { ok: false, reason: "SVG skipped (palette extraction expects raster).", contentType: ct };

    const buf = Buffer.from(await res.arrayBuffer());
    const filename = `${sha256(url)}${ext || ""}`;
    const outPath = path.join(outDir, filename);
    await fs.writeFile(outPath, buf);

    return { ok: true, path: outPath, contentType: ct };
  } catch (e: any) {
    return { ok: false, reason: e?.name === "AbortError" ? "Download timeout" : String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/** Try to get palette from a local raster file; if it's WebP and sharp is installed, convert to PNG first. */
async function vibrantPaletteFromFile(localPath: string, contentType?: string) {
  const ct = (contentType || "").toLowerCase();
  const isWebp = ct.includes("image/webp") || localPath.toLowerCase().endsWith(".webp");

  if (!isWebp) {
    const pal = await Vibrant.from(localPath).getPalette();
    return paletteToSwatches(pal);
  }

  // Optional: convert webp -> png using sharp if available
  try {
    const sharpMod = await import("sharp");
    const sharp = (sharpMod as any).default ?? (sharpMod as any);

    const pngPath = localPath.replace(/\.webp$/i, ".png") || `${localPath}.png`;
    await sharp(localPath).png().toFile(pngPath);

    const pal = await Vibrant.from(pngPath).getPalette();
    return paletteToSwatches(pal);
  } catch {
    // If sharp isn't installed or conversion fails, try Vibrant directly anyway
    const pal = await Vibrant.from(localPath).getPalette();
    return paletteToSwatches(pal);
  }
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option("url", { type: "string", demandOption: true, describe: "URL to scrape" })
    .option("out", { type: "string", default: "out", describe: "Output folder" })
    .option("width", { type: "number", default: 1440 })
    .option("height", { type: "number", default: 900 })
    .option("timeoutMs", { type: "number", default: 45000 })
    .option("blockAds", { type: "boolean", default: true })
    .option("maxDomSample", { type: "number", default: 2500 })
    .option("maxBrandImages", { type: "number", default: 8 })
    .option("downloadTimeoutMs", { type: "number", default: 15000 })
    .help()
    .parse();

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const url = argv.url;
  const baseOutDir = path.resolve(__dirname, "..", argv.out);
  const runDir = path.join(baseOutDir, String(Date.now()));
  const imagesDir = path.join(runDir, "images");
  await ensureDir(imagesDir);

  const notes: string[] = [];

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: argv.width, height: argv.height });
    page.setDefaultNavigationTimeout(argv.timeoutMs);

    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

    if (argv.blockAds) {
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const rt = req.resourceType();
        const u = req.url().toLowerCase();

        const blocked =
          u.includes("doubleclick") ||
          u.includes("googlesyndication") ||
          u.includes("googleadservices") ||
          u.includes("facebook.com/tr") ||
          u.includes("hotjar") ||
          u.includes("optimizely") ||
          u.includes("taboola") ||
          u.includes("criteo") ||
          u.includes("mgid") ||
          u.includes("tiktok") ||
          u.includes("ads-twitter") ||
          u.includes("analytics.twitter") ||
          u.includes("adnxs") ||
          u.includes("adserver.") ||
          false;

        if (blocked && (rt === "script" || rt === "xhr" || rt === "fetch")) {
          req.abort().catch(() => {});
        } else {
          req.continue().catch(() => {});
        }
      });

      notes.push("Request interception enabled (blocking common trackers).");
    }

    // ---- Navigate ----
    try {
      await safeGoto(page, url, argv.timeoutMs);
    } catch (e: any) {
      const ts = Date.now();
      const debugScreenshotPath = path.join(runDir, `debug-${ts}.png`);
      const debugHtmlPath = path.join(runDir, `debug-${ts}.html`);

      await page.screenshot({ path: debugScreenshotPath, fullPage: true }).catch(() => {});
      const html = await page.content().catch(() => "");
      if (html) await fs.writeFile(debugHtmlPath, html, "utf-8").catch(() => {});

      throw new Error(
        `${String(e?.message || e)}\nDebug screenshot: ${debugScreenshotPath}\nDebug HTML: ${debugHtmlPath}`
      );
    }

    const finalUrl = page.url();
    const title = await page.title().catch(() => null);

    // ---- Collect asset URLs + top brand images (WITH SIZE DATA) ----
    const assets = await page.evaluate(() => {
      const abs = (u: string) => {
        try {
          return new URL(u, document.baseURI).toString();
        } catch {
          return "";
        }
      };
      const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)));

      const images: string[] = [];
      const videos: string[] = [];
      const stylesheets: string[] = [];
      const scripts: string[] = [];
      const fonts: string[] = [];

      document.querySelectorAll("img").forEach((el) => {
        const img = el as HTMLImageElement;
        const s = img.currentSrc || img.src || "";
        if (s) images.push(abs(s));
      });

      document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').forEach((el) => {
        const href = (el as HTMLLinkElement).href || "";
        if (href) images.push(abs(href));
      });

      document.querySelectorAll('meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"]').forEach((el) => {
        const c = (el as HTMLMetaElement).content || "";
        if (c) images.push(abs(c));
      });

      // videos
      document.querySelectorAll("video").forEach((el) => {
        const v = (el as HTMLVideoElement).currentSrc || (el as HTMLVideoElement).src || "";
        if (v) videos.push(abs(v));
        (el as HTMLVideoElement).querySelectorAll("source").forEach((s) => {
          const src = (s as HTMLSourceElement).src || "";
          if (src) videos.push(abs(src));
        });
      });

      // stylesheets
      document.querySelectorAll('link[rel="stylesheet"]').forEach((el) => {
        const href = (el as HTMLLinkElement).href || "";
        if (href) stylesheets.push(abs(href));
      });

      // scripts
      document.querySelectorAll("script[src]").forEach((el) => {
        const src = (el as HTMLScriptElement).src || "";
        if (src) scripts.push(abs(src));
      });

      // fonts (parse @font-face url())
      const cssTexts: string[] = [];
      document.querySelectorAll("style").forEach((s) => cssTexts.push((s as HTMLStyleElement).textContent || ""));
      for (const ss of Array.from(document.styleSheets)) {
        try {
          const rules = (ss as CSSStyleSheet).cssRules;
          if (!rules) continue;
          for (const r of Array.from(rules)) cssTexts.push((r as CSSRule).cssText || "");
        } catch {}
      }

      const fontRe = /url\(([^)]+)\)/g;
      for (const txt of cssTexts) {
        let m: RegExpExecArray | null;
        while ((m = fontRe.exec(txt))) {
          const raw = m[1].replace(/["']/g, "").trim();
          if (/\.(woff2?|ttf|otf)(\?.*)?$/i.test(raw)) fonts.push(abs(raw));
        }
      }

      // Top "brand images" candidates: rank by on-screen area, but also include natural size
      const candidates: Array<{ url: string; area: number; naturalArea: number; w: number; h: number }> = [];
      document.querySelectorAll("img").forEach((el) => {
        const img = el as HTMLImageElement;
        const src = img.currentSrc || img.src || "";
        if (!src) return;
        if (src.startsWith("data:")) return;

        const r = img.getBoundingClientRect();
        const area = Math.max(0, r.width) * Math.max(0, r.height);

        const nw = img.naturalWidth || 0;
        const nh = img.naturalHeight || 0;
        const naturalArea = nw * nh;

        candidates.push({ url: abs(src), area, naturalArea, w: nw, h: nh });
      });

      candidates.sort((a, b) => (b.area - a.area) || (b.naturalArea - a.naturalArea));
      return {
        images: uniq(images),
        videos: uniq(videos),
        stylesheets: uniq(stylesheets),
        scripts: uniq(scripts),
        fonts: uniq(fonts),
        topImageCandidates: candidates.slice(0, 40),
      };
    });

    // ---- Screenshot + palette ----
    const screenshotPath = path.join(runDir, "screenshot.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const screenshotPalette = await Vibrant.from(screenshotPath).getPalette();
    const fromScreenshot = paletteToSwatches(screenshotPalette);

    // ---- CSS stats ----
    const styleStats = await page.evaluate((maxDomSample) => {
      function isVisible(el: Element): boolean {
        const style = window.getComputedStyle(el);
        if (!style) return false;
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = (el as HTMLElement).getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      const all = Array.from(document.querySelectorAll("*")).filter(isVisible);
      const sample = all.slice(0, maxDomSample);

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
    }, argv.maxDomSample);

    const normalizeTop = (entries: Array<[string, number]>, take = 15) => {
      const sorted = [...entries].sort((a, b) => b[1] - a[1]).slice(0, take);
      const colors: string[] = [];
      for (const [raw] of sorted) {
        const hex = normalizeCssColor(raw);
        if (hex) colors.push(hex);
      }
      return uniq(colors);
    };

    const backgroundColors = normalizeTop(styleStats.bg, 20);
    const textColors = normalizeTop(styleStats.fg, 20);
    const linkColors = normalizeTop(styleStats.link, 15);
    const borderColors = normalizeTop(styleStats.border, 15);

    const accentCandidates = uniq(
      [...linkColors, ...fromScreenshot.rankedHex.slice(0, 6), ...textColors.slice(0, 6)].filter((hex) => {
        const c = colord(hex);
        if (!c.isValid()) return false;
        const { r, g, b } = c.toRgb();
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        return max - min > 18;
      })
    ).slice(0, 12);

    const topFromEntries = (entries: Array<[string, number]>, take = 10) =>
      [...entries]
        .sort((a, b) => b[1] - a[1])
        .slice(0, take)
        .map(([v]) => v);

    const fontFamilies = uniq(topFromEntries(styleStats.fonts, 12));
    const fontSizesPx = uniq(
      topFromEntries(styleStats.fontSizes, 12)
        .map((s) => Number(s.replace("px", "")))
        .filter((n) => Number.isFinite(n))
    );
    const fontWeights = uniq(
      topFromEntries(styleStats.fontWeights, 12)
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n))
    );
    const lineHeightsPx = uniq(
      topFromEntries(styleStats.lineHeights, 12)
        .map((s) => Number(s.replace("px", "")))
        .filter((n) => Number.isFinite(n))
    );

    // ---- Contrast checks ----
    const contrastChecks: BrandStyleSnapshot["contrastChecks"] = [];
    const fgCandidates = textColors.slice(0, 6);
    const bgCandidates = backgroundColors.slice(0, 6);
    for (const fg of fgCandidates) {
      for (const bg of bgCandidates) {
        const ratio = colord(fg).contrast(colord(bg));
        contrastChecks.push({
          fg,
          bg,
          ratio: Math.round(ratio * 100) / 100,
          passesAA: ratio >= 4.5,
          passesAAA: ratio >= 7.0,
        });
      }
    }

    // ---- Image inventory + brand/tracking split ----
    const allImages = uniq(assets.images).filter((u) => !looksLikeVideoUrl(u)); // don’t treat mp4s as images
    const trackingPixels = allImages.filter((u) => isTrackingPixelUrl(u));
    const brandImages = allImages.filter((u) => !isTrackingPixelUrl(u));

    // ---- Choose brand raster images to download + palette-scan ----
    // Use the ranked <img> candidates, but require real size.
    const candidateBrandRaster = uniq(
      (assets.topImageCandidates as Array<{ url: string; area: number; naturalArea: number; w: number; h: number }>)
        .filter((c) => isHttpUrl(c.url) && !isDataUrl(c.url))
        .filter((c) => !looksLikeSvg(c.url))
        .filter((c) => !isTrackingPixelUrl(c.url))
        // reject tiny images / icons / beacons
        .filter((c) => (c.w >= 120 && c.h >= 120) || c.naturalArea >= 25000 || c.area >= 120 * 120)
        .map((c) => c.url)
    ).slice(0, Math.max(0, argv.maxBrandImages));

    if (candidateBrandRaster.length === 0) {
      notes.push("No suitable raster brand images found for per-image palettes (filtered tiny/trackers/SVG).");
    }

    // ---- Download + vibrant palette for each candidate raster image ----
    const fromImages: BrandStyleSnapshot["palettes"]["fromImages"] = {};
    const downloadedImagePaths: BrandStyleSnapshot["assets"]["downloadedImagePaths"] = [];

    for (const imgUrl of candidateBrandRaster) {
      const dl = await downloadImageUnique(imgUrl, imagesDir, argv.downloadTimeoutMs);
      downloadedImagePaths.push({
        url: imgUrl,
        path: dl.path || "",
        ok: dl.ok,
        reason: dl.reason,
        contentType: dl.contentType,
      });

      if (!dl.ok || !dl.path) {
        fromImages[imgUrl] = null;
        continue;
      }

      try {
        const shaped = await vibrantPaletteFromFile(dl.path, dl.contentType);
        fromImages[imgUrl] = { ...shaped, downloadedPath: dl.path };
      } catch {
        fromImages[imgUrl] = null;
      }
    }

    // ---- Final report ----
    const report: BrandStyleSnapshot = {
      url,
      timestampIso: new Date().toISOString(),
      page: {
        title,
        finalUrl,
        viewport: { width: argv.width, height: argv.height },
        notes,
      },
      colors: {
        extractedFromScreenshot: fromScreenshot,
        css: {
          backgroundColors,
          textColors,
          linkColors,
          borderColors,
          accentCandidates,
        },
      },
      palettes: {
        fromScreenshot,
        fromImages,
      },
      typography: {
        fontFamilies,
        fontSizesPx: fontSizesPx.sort((a, b) => a - b),
        fontWeights: fontWeights.sort((a, b) => a - b),
        lineHeightsPx: lineHeightsPx.sort((a, b) => a - b),
      },
      contrastChecks: contrastChecks.sort((a, b) => b.ratio - a.ratio).slice(0, 30),
      assets: {
        screenshotPath,
        outputDir: runDir,

        images: allImages,
        brandImages,
        trackingPixels,

        videos: uniq(assets.videos),
        stylesheets: uniq(assets.stylesheets),
        scripts: uniq(assets.scripts),
        fonts: uniq(assets.fonts),

        downloadedImagePaths,
      },
    };

    const reportPath = path.join(runDir, "report.json");
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

    console.log("Done");
    console.log("Report:", reportPath);
    console.log("Run dir:", runDir);
    console.log("Screenshot:", screenshotPath);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Error:", err?.message || err);
  process.exit(1);
});


