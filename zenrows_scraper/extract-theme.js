// extract-theme.js
// Usage:
//   node extract-theme.js --url https://toyota.com --out out/toyota.com/20260119_201235/theme.json
//
// Notes:
// - Extracts computed styles from representative elements + best "primary CTA" + "secondary CTA".
// - Avoids common wrapper tiles like `.assets-wrapper` and requires label/text/aria-label.
// - Also writes a screenshot next to the theme json for palette extraction.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

(async () => {
  const url = arg("--url");
  const outPath = arg("--out", "theme.json");
  const timeoutMs = Number(arg("--timeout", "45000"));

  if (!url) {
    console.error("Missing --url");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, // mobile-ish baseline
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForTimeout(1500);

  // Reduce animation/transition noise
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.innerHTML = `*{ transition:none !important; animation:none !important; }`;
    document.head.appendChild(style);
  });
  await page.waitForTimeout(500);

  const theme = await page.evaluate(() => {
    // ---------------- helpers ----------------
    function getLabel(el) {
      const aria = (el.getAttribute("aria-label") || "").trim();
      const title = (el.getAttribute("title") || "").trim();
      const txt = (el.textContent || "").trim().replace(/\s+/g, " ");
      return aria || title || txt;
    }

    function rgbToNums(rgb) {
      const m = (rgb || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/i);
      if (!m) return null;
      return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] == null ? 1 : Number(m[4])];
    }

    function isTransparent(bg) {
      if (!bg) return true;
      if (bg === "transparent") return true;
      const n = rgbToNums(bg);
      if (!n) return true;
      return n[3] === 0; // alpha == 0
    }

    function saturationScore(rgb) {
      const n = rgbToNums(rgb);
      if (!n) return 0;
      let [r, g, b] = n;
      r /= 255;
      g /= 255;
      b /= 255;
      const max = Math.max(r, g, b),
        min = Math.min(r, g, b);
      return max === 0 ? 0 : (max - min) / max; // 0..1
    }

    function pick(el) {
      if (!el) return null;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        classes: (el.className || "").toString(),
        id: el.id || "",
        text: (getLabel(el) || "").slice(0, 140),
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        colors: {
          color: s.color,
          backgroundColor: s.backgroundColor,
          borderColor: s.borderColor,
          outlineColor: s.outlineColor,
        },
        typography: {
          fontFamily: s.fontFamily,
          fontSize: s.fontSize,
          fontWeight: s.fontWeight,
          lineHeight: s.lineHeight,
          letterSpacing: s.letterSpacing,
          textTransform: s.textTransform,
        },
        shape: {
          borderRadius: s.borderRadius,
          borderWidth: s.borderWidth,
          boxShadow: s.boxShadow,
        },
        spacing: {
          padding: `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}`,
          margin: `${s.marginTop} ${s.marginRight} ${s.marginBottom} ${s.marginLeft}`,
        },
        misc: {
          cursor: s.cursor,
          display: s.display,
          opacity: s.opacity,
        },
      };
    }

    function collectCssVariablesFromStylesheets() {
      const vars = {};
      const sources = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try {
          rules = sheet.cssRules;
        } catch (e) {
          continue; // cross-origin stylesheet: cannot read
        }
        if (!rules) continue;

        for (const rule of Array.from(rules)) {
          if (rule.type !== CSSRule.STYLE_RULE) continue;
          const sel = rule.selectorText || "";
          if (!sel.includes(":root") && !sel.includes("html")) continue;

          const style = rule.style;
          let any = false;
          for (const name of Array.from(style)) {
            if (name.startsWith("--")) {
              const val = style.getPropertyValue(name).trim();
              if (val) {
                vars[name] = val;
                any = true;
              }
            }
          }
          if (any) sources.push(sel);
        }
      }
      return { vars, sources };
    }

    // ---------------- representative elements ----------------
    const body = document.body;
    const header =
      document.querySelector("header") ||
      document.querySelector('[role="banner"]') ||
      document.querySelector("nav");

    const anyLink = document.querySelector("a");

    const logoImg =
      document.querySelector('img[alt*="toyota" i]') ||
      document.querySelector('img[alt*="logo" i]') ||
      (header ? header.querySelector("img") : null) ||
      document.querySelector("img");

    // ---------------- CTA selection (the important part) ----------------
    const candidates = Array.from(
      document.querySelectorAll("button,a,[role='button'],input[type='submit'],input[type='button']")
    )
      .filter((el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();

        // visible and reasonably sized
        if (r.width < 90 || r.height < 28) return false;
        if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity || "1") < 0.1) return false;

        // clicky
        const clicky = el.tagName === "BUTTON" || el.getAttribute("role") === "button" || s.cursor === "pointer";
        if (!clicky) return false;

        // reject known wrapper tiles / carousel wrappers
        const cls = (el.className || "").toString();
        if (cls.includes("assets-wrapper")) return false;

        // require label (text or aria-label/title)
        const label = getLabel(el);
        if (!label) return false;

        return true;
      })
      .slice(0, 800);

    function scoreCTA(el) {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();

      const bg = s.backgroundColor;
      const border = s.borderColor;
      const filled = !isTransparent(bg);

      // prefer strong color either as fill or as outline
      const sat = saturationScore(filled ? bg : border);

      // normalize size
      const area = Math.min(14, (r.width * r.height) / (170 * 44));

      const label = getLabel(el).toLowerCase();

      // prefer typical CTA words
      const ctaWordBonus = /explore|build|shop|search|inventory|learn|see|get|find|offers|browse|continue|next|locate|dealer/.test(label)
        ? 4
        : 0;

      const filledBonus = filled ? 9 : 0;
      const buttonBonus = el.tagName === "BUTTON" ? 4 : 0;
      const cursorBonus = s.cursor === "pointer" ? 2 : 0;

      // slight bonus if rounded (looks like modern CTA)
      const radius = parseFloat(s.borderRadius || "0");
      const radiusBonus = radius >= 4 ? 1 : 0;

      return sat * 10 + area + filledBonus + buttonBonus + cursorBonus + radiusBonus + ctaWordBonus;
    }

    const scored = candidates
      .map((el) => ({ el, score: scoreCTA(el) }))
      .sort((a, b) => b.score - a.score);

    const primary = scored[0]?.el || null;

    // choose secondary: distinct element, preferably with different label or different style
    let secondary = null;
    if (primary) {
      const primaryLabel = getLabel(primary).toLowerCase();
      const ps = getComputedStyle(primary);
      for (let i = 1; i < scored.length; i++) {
        const el = scored[i].el;
        if (!el || el === primary) continue;

        const label = getLabel(el).toLowerCase();
        const s = getComputedStyle(el);

        const labelDifferent = label && label !== primaryLabel;
        const styleDifferent = s.backgroundColor !== ps.backgroundColor || s.borderColor !== ps.borderColor || s.color !== ps.color;

        if (labelDifferent || styleDifferent) {
          secondary = el;
          break;
        }
      }
    } else {
      secondary = scored[1]?.el || null;
    }

    // ---------------- fonts in use ----------------
    const fontFamilies = new Set();
    for (const el of Array.from(document.querySelectorAll("body,h1,h2,h3,p,a,button,input,label,small,span")).slice(0, 700)) {
      const ff = getComputedStyle(el).fontFamily;
      if (ff) fontFamilies.add(ff);
    }

    const cssVars = collectCssVariablesFromStylesheets();

    return {
      meta: {
        url: location.href,
        title: document.title,
        extractedAt: new Date().toISOString(),
      },
      cssVariables: {
        vars: cssVars.vars,
        sources: cssVars.sources,
      },
      computed: {
        body: pick(body),
        header: pick(header),
        link: pick(anyLink),
        primaryAction: pick(primary),
        secondaryAction: pick(secondary),
        logo: logoImg
          ? {
              src: logoImg.currentSrc || logoImg.getAttribute("src") || "",
              alt: logoImg.getAttribute("alt") || "",
            }
          : null,
      },
      fontFamilies: Array.from(fontFamilies),
      debug: {
        primaryScore: scored[0]?.score ?? null,
        secondaryScore: secondary ? scored.find((x) => x.el === secondary)?.score ?? null : null,
        topCandidates: scored
          .slice(0, 10)
          .map((x) => ({
            score: x.score,
            tag: x.el.tagName.toLowerCase(),
            id: x.el.id || "",
            classes: (x.el.className || "").toString(),
            label: (getLabel(x.el) || "").slice(0, 120),
            bg: getComputedStyle(x.el).backgroundColor,
            border: getComputedStyle(x.el).borderColor,
            color: getComputedStyle(x.el).color,
          })),
      },
    };
  });

  // Ensure output directory exists
  const outDir = path.dirname(outPath);
  if (outDir && outDir !== ".") fs.mkdirSync(outDir, { recursive: true });

  // Save screenshot alongside the json
  const shotPath = outPath.replace(/\.json$/i, "") + ".png";
  await page.screenshot({ path: shotPath, fullPage: true });

  fs.writeFileSync(outPath, JSON.stringify(theme, null, 2), "utf-8");

  await browser.close();

  console.log("Wrote:", outPath);
  console.log("Screenshot:", shotPath);

  // Helpful console output for debugging CTA selection
  if (theme?.debug?.topCandidates?.length) {
    console.log("Top CTA candidates:");
    for (const c of theme.debug.topCandidates) {
      console.log(`- ${c.score.toFixed(2)} | ${c.tag}#${c.id}.${c.classes} | "${c.label}" | bg:${c.bg}`);
    }
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
