// build-brand-theme.js
// Usage:
//   node build-brand-theme.js --theme out/toyota.com/20260119_201235/theme.json --out out/toyota.com/20260119_201235/brand-theme.css
//
// This converts theme.json (computed styles) into CSS overrides for your ad template.

const fs = require("fs");
const path = require("path");

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

function rgbToHex(rgb) {
  const m = (rgb || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!m) return null;
  const toHex = (n) => Number(n).toString(16).padStart(2, "0");
  return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`.toUpperCase();
}

function pickBrandPrimary(theme) {
  // Prefer CTA border (Toyota uses outline CTAs often)
  const p = theme?.computed?.primaryAction?.colors;
  const s = theme?.computed?.secondaryAction?.colors;

  const candidates = [
    p?.backgroundColor,
    p?.borderColor,
    p?.color,
    s?.backgroundColor,
    s?.borderColor,
    s?.color,
  ]
    .map(rgbToHex)
    .filter(Boolean)
    // remove white/black/near-grays
    .filter((hex) => !["#FFFFFF", "#000000"].includes(hex));

  return candidates[0] || "#E10A1D"; // sensible fallback
}

const themePath = arg("--theme");
const outPath = arg("--out", "brand-theme.css");
if (!themePath) {
  console.error("Missing --theme");
  process.exit(1);
}

const theme = JSON.parse(fs.readFileSync(themePath, "utf-8"));

const font = theme?.computed?.body?.typography?.fontFamily || "Arial, sans-serif";
const bodyBg = rgbToHex(theme?.computed?.body?.colors?.backgroundColor) || "#FFFFFF";
const headerBg = rgbToHex(theme?.computed?.header?.colors?.backgroundColor) || "#FFFFFF";
const headerBorderRaw = theme?.computed?.header?.colors?.borderColor || "";
const primary = pickBrandPrimary(theme);

// If borderColor is like "rgb(...) rgb(...) rgb(...)" take the last one (bottom border)
let headerBorder = null;
const borderMatches = headerBorderRaw.match(/rgb\([^)]+\)/g);
if (borderMatches && borderMatches.length) headerBorder = rgbToHex(borderMatches[borderMatches.length - 1]);
headerBorder = headerBorder || "#E6E6E6";

const css = `
/* Auto-generated from theme.json */
:root{
  --brand-primary: ${primary};
  --brand-bg: ${bodyBg};
  --brand-header-bg: ${headerBg};
  --brand-header-border: ${headerBorder};
  --brand-font: ${font};
}

/* Global typography */
.main-container{
  font-family: var(--brand-font) !important;
}

/* Tile/background */
.box-tile{
  background: var(--brand-bg) !important;
  border-color: rgba(0,0,0,0.25) !important;
}

/* Header */
.vi-header{
  background: var(--brand-header-bg) !important;
  border-bottom: 1px solid var(--brand-header-border) !important;
}

/* Accent links */
.vi-fill-out a,
.offerDetails a,
.vi-terms-text a{
  color: var(--brand-primary) !important;
}

/* CTA button (your "Claim Offer" / primary) */
.vi-offerBtn.active{
  background: var(--brand-primary) !important;
  border-color: var(--brand-primary) !important;
  color: #FFFFFF !important;
}

/* Secondary button (call button) */
.vi-telBtn{
  border-color: rgba(255,255,255,0.35) !important;
}

/* Slider dots + visited */
.slick-dots li.slick-active,
.vi-visited{
  background-color: var(--brand-primary) !important;
}
.slick-dots li.slick-active::before,
.slick-dots li.vi-visited::before{
  background-color: var(--brand-primary) !important;
}

/* Remove any lingering Vivint-blue dot color */
.slick-active button{
  background-color: var(--brand-primary) !important;
}
`.trim() + "\n";

const outDir = path.dirname(outPath);
if (outDir && outDir !== ".") fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, css, "utf-8");
console.log("Wrote:", outPath);
console.log("Primary:", primary, "Font:", font);
