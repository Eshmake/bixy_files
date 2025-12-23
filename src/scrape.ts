import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";
import { Vibrant } from "node-vibrant/node";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { colord, extend } from "colord";
import a11yPlugin from "colord/plugins/a11y";

import { a11y } from "colord/plugins/a11y";

type BrandStyleSnapshot = {
  url: string;
  timestampIso: string;
  page: {
    title: string | null;
    finalUrl: string;
    viewport: { width: number; height: number };
  };
  colors: {
    extractedFromScreenshot: {
      swatches: Record<
        string,
        { hex: string; rgb: [number, number, number]; population: number }
      >;
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

  // treat fully transparent rgba as null
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

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option("url", { type: "string", demandOption: true, describe: "URL to scrape" })
    .option("out", { type: "string", default: "out", describe: "Output folder" })
    .option("width", { type: "number", default: 1440 })
    .option("height", { type: "number", default: 900 })
    .option("timeoutMs", { type: "number", default: 45000 })
    .option("waitUntil", {
      type: "string",
      default: "networkidle2",
      choices: ["load", "domcontentloaded", "networkidle0", "networkidle2"] as const,
    })
    .help()
    .parse();

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const url = argv.url;
  const outDir = path.resolve(__dirname, "..", argv.out);
  await ensureDir(outDir);

  const browser = await puppeteer.launch({
    headless: true
    // If running in CI/docker, you may need:
    // args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: argv.width, height: argv.height });
    page.setDefaultNavigationTimeout(argv.timeoutMs);

    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36"
    );

    const resp = await page.goto(url, { waitUntil: argv.waitUntil as any });
    if (!resp) throw new Error("Navigation failed: no response");

    const finalUrl = page.url();
    await page.waitForTimeout(800);

    const title = await page.title().catch(() => null);

    const screenshotPath = path.join(outDir, `screenshot-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const palette = await Vibrant.from(screenshotPath).getPalette();

    const swatches: BrandStyleSnapshot["colors"]["extractedFromScreenshot"]["swatches"] = {};
    for (const [name, sw] of Object.entries(palette)) {
      if (!sw) continue;
      const rgb = sw.getRgb().map((v) => Math.round(v)) as [number, number, number];
      swatches[name] = {
        hex: sw.getHex().toUpperCase(),
        rgb,
        population: sw.getPopulation(),
      };
    }

    const rankedHex = Object.values(swatches)
      .sort((a, b) => b.population - a.population)
      .map((s) => s.hex);

    const styleStats = await page.evaluate(() => {
      function isVisible(el: Element): boolean {
        const style = window.getComputedStyle(el);
        if (!style) return false;
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = (el as HTMLElement).getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      const all = Array.from(document.querySelectorAll("*")).filter(isVisible);
      const sample = all.slice(0, 2500);

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
      [
        ...linkColors,
        ...rankedHex.slice(0, 6),
        ...textColors.slice(0, 6),
      ].filter((hex) => {
        const c = colord(hex);
        if (!c.isValid()) return false;
        const { r, g, b } = c.toRgb();
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        return max - min > 18; // remove near-grays
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

    const report: BrandStyleSnapshot = {
      url,
      timestampIso: new Date().toISOString(),
      page: {
        title,
        finalUrl,
        viewport: { width: argv.width, height: argv.height },
      },
      colors: {
        extractedFromScreenshot: { swatches, rankedHex },
        css: {
          backgroundColors,
          textColors,
          linkColors,
          borderColors,
          accentCandidates,
        },
      },
      typography: {
        fontFamilies,
        fontSizesPx: fontSizesPx.sort((a, b) => a - b),
        fontWeights: fontWeights.sort((a, b) => a - b),
        lineHeightsPx: lineHeightsPx.sort((a, b) => a - b),
      },
      contrastChecks: contrastChecks.sort((a, b) => b.ratio - a.ratio).slice(0, 30),
      assets: { screenshotPath },
    };

    const reportPath = path.join(outDir, `report-${Date.now()}.json`);
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

    console.log("✅ Done");
    console.log("Report:", reportPath);
    console.log("Screenshot:", screenshotPath);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
