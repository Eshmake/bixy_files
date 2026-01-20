// palette.js
// Usage: node palette.js /path/to/image
// Outputs JSON to stdout.
//
// Compatible with newer node-vibrant exports and multiple swatch shapes.

const { Vibrant } = require("node-vibrant/node");
const { colord } = require("colord");
const fs = require("fs");
const path = require("path");

function readHex(sw) {
  if (!sw) return null;
  if (typeof sw.getHex === "function") return sw.getHex();
  if (typeof sw.hex === "string") return sw.hex;
  if (typeof sw.hexString === "function") return sw.hexString();
  return null;
}

function readPopulation(sw) {
  if (!sw) return null;
  if (typeof sw.getPopulation === "function") return sw.getPopulation();
  if (typeof sw.population === "number") return sw.population;
  return null;
}

function readRgb(sw) {
  if (!sw) return null;
  if (typeof sw.getRgb === "function") return sw.getRgb();
  if (Array.isArray(sw.rgb)) return sw.rgb;
  if (sw.r != null && sw.g != null && sw.b != null) return [sw.r, sw.g, sw.b];
  return null;
}

function safeHex(hex) {
  if (!hex) return null;
  const c = colord(hex);
  return c.isValid() ? c.toHex() : null;
}

function brightnessFromRgb(rgb) {
  const { r, g, b } = rgb;
  return Math.round((0.299 * r) + (0.587 * g) + (0.114 * b));
}

function colorInfo(hex) {
  const c = colord(hex);
  if (!c.isValid()) return null;
  const rgb = c.toRgb();
  const brightness = brightnessFromRgb(rgb);
  const isLight = typeof c.isLight === "function" ? c.isLight() : brightness >= 140;
  const isDark  = typeof c.isDark  === "function" ? c.isDark()  : brightness < 140;
  return {
    hex: c.toHex(),
    rgb,
    hsl: c.toHsl(),
    brightness,
    isLight,
    isDark,
  };
}

(async () => {
  const imgPath = process.argv[2];
  if (!imgPath) {
    console.error("Missing image path. Example: node palette.js out/assets/site_page.png");
    process.exit(2);
  }
  if (!fs.existsSync(imgPath)) {
    console.error(`Image not found: ${imgPath}`);
    process.exit(2);
  }

  try {
    const palette = await Vibrant.from(imgPath).getPalette();

    const swatches = {};
    for (const [name, sw] of Object.entries(palette)) {
      const hex = readHex(sw);
      swatches[name] = sw
        ? {
            hex,
            population: readPopulation(sw),
            rgb: readRgb(sw),
          }
        : null;
    }

    const ranked = Object.entries(palette)
      .filter(([_, sw]) => !!sw)
      .map(([name, sw]) => ({
        name,
        hex: readHex(sw),
        population: readPopulation(sw) ?? 0,
      }))
      .filter((x) => !!x.hex)
      .sort((a, b) => (b.population || 0) - (a.population || 0));

    const rankedHex = ranked.map((x) => safeHex(x.hex)).filter(Boolean);
    const primary = rankedHex[0] || null;
    const primaryInfo = primary ? colorInfo(primary) : null;

    const suggestedTextOnPrimary = primaryInfo
      ? (primaryInfo.isLight ? "#000000" : "#FFFFFF")
      : null;

    const result = {
      input: {
        imagePath: imgPath,
        fileName: path.basename(imgPath),
      },
      vibrant: {
        swatches,
        ranked,
        rankedHex,
        primary,
        primaryInfo,
        suggestedTextOnPrimary,
      },
    };

    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  }
})();
