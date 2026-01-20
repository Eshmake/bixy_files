# run_brand_scrape.py
# ZenRows parity report builder (replacement for Puppeteer pipeline)
#
# Produces:
#   out/<host>/<timestamp>/report.json
#   out/<host>/<timestamp>/assets/*
#
# Requirements:
#   pip install requests beautifulsoup4 python-dotenv
#   npm i node-vibrant colord
#
# Also requires palette.js in this same folder.

from __future__ import annotations

import os
import re
import json
import math
import hashlib
import subprocess
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse
from typing import Dict, List, Optional, Tuple

import requests

from zenrows_fetch import fetch_rendered_html, fetch_screenshot_png, fetch_json_response
from extract_dom import extract_dom


# -----------------------------
# Node post-processing helpers
# -----------------------------

def run_node(cmd: List[str], *, cwd: Optional[str] = None, timeout_s: int = 180) -> Tuple[int, str, str]:
    """Run a Node command and capture (returncode, stdout, stderr)."""
    p = subprocess.run(
        cmd,
        cwd=cwd,
        timeout=timeout_s,
        capture_output=True,
        text=True,
        check=False,
    )
    return p.returncode, p.stdout, p.stderr


def generate_theme_artifacts(url: str, out_dir: Path) -> Dict[str, str]:
    """Run extract-theme.js then build-brand-theme.js (best effort).

    Produces:
      out_dir/theme.json
      out_dir/brand-theme.css
      out_dir/theme.png  (screenshot created by extract-theme.js)
    """
    script_dir = Path(__file__).resolve().parent
    extract_js = script_dir / "extract-theme.js"
    build_js = script_dir / "build-brand-theme.js"

    theme_json = out_dir / "theme.json"
    brand_css = out_dir / "brand-theme.css"

    info: Dict[str, str] = {
        "themeJsonPath": str(theme_json),
        "brandCssPath": str(brand_css),
        "themeScreenshotPath": str(out_dir / "theme.png"),
    }

    if not extract_js.exists():
        return {"error": f"missing {extract_js.name}"}
    if not build_js.exists():
        return {"error": f"missing {build_js.name}"}

    # 1) extract-theme.js (uses Playwright)
    rc, extract_out, extract_err = run_node(
        ["node", str(extract_js), "--url", url, "--out", str(theme_json)],
        cwd=str(script_dir),
        timeout_s=240,
    )
    if rc != 0:
        return {
            "error": "extract-theme failed",
            "extractStdout": extract_out.strip(),
            "extractStderr": extract_err.strip(),
        }

    # 2) build-brand-theme.js
    rc, build_out, build_err = run_node(
        ["node", str(build_js), "--theme", str(theme_json), "--out", str(brand_css)],
        cwd=str(script_dir),
        timeout_s=60,
    )
    if rc != 0:
        return {
            "error": "build-brand-theme failed",
            "buildStdout": build_out.strip(),
            "buildStderr": build_err.strip(),
        }

    # success
    return {
        **info,
        "extractStdout": extract_out.strip(),
        "extractStderr": extract_err.strip(),
        "buildStdout": build_out.strip(),
        "buildStderr": build_err.strip(),
    }

SUPPORTED_CT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/bmp": "bmp",
}


def host_slug(url: str) -> str:
    return urlparse(url).netloc.replace("www.", "")


def now_stamp() -> str:
    # local timestamp for folder naming
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def save_json(data: dict, path: str) -> str:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    return path


def download(url: str, out_path: str) -> Dict:
    r = requests.get(
        url,
        timeout=30,
        allow_redirects=True,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "image/*,*/*;q=0.8",
        },
    )
    r.raise_for_status()

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(r.content)

    content_type = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    return {
        "requested_url": url,
        "final_url": r.url,
        "content_type": content_type,
        "bytes": len(r.content),
        "path": out_path,
        "status": r.status_code,
    }


def node_palette(image_path: str) -> dict:
    p = subprocess.run(
        ["node", "palette.js", image_path],
        capture_output=True,
        text=True,
        check=False,
    )
    if p.returncode != 0:
        raise RuntimeError(f"palette.js failed:\nSTDOUT:\n{p.stdout}\nSTDERR:\n{p.stderr}")
    return json.loads(p.stdout)


def _parse_css_tokens(css_text: str) -> Dict:
    vars_found = dict(re.findall(r"(--[\w-]+)\s*:\s*([^;}{]+)\s*;", css_text))
    font_families = re.findall(r"font-family\s*:\s*([^;}{]+)\s*;", css_text, flags=re.I)
    font_sizes = re.findall(r"font-size\s*:\s*([^;}{]+)\s*;", css_text, flags=re.I)
    font_weights = re.findall(r"font-weight\s*:\s*([^;}{]+)\s*;", css_text, flags=re.I)
    line_heights = re.findall(r"line-height\s*:\s*([^;}{]+)\s*;", css_text, flags=re.I)
    hex_colors = re.findall(r"#[0-9a-fA-F]{3,8}\b", css_text)
    rgb_colors = re.findall(r"rgba?\([^)]+\)", css_text, flags=re.I)

    def uniq(seq: List[str]) -> List[str]:
        seen = set()
        out = []
        for x in seq:
            x = x.strip()
            if not x or x in seen:
                continue
            seen.add(x)
            out.append(x)
        return out

    return {
        "css_vars": dict(list(vars_found.items())[:500]),
        "fontFamilies": uniq(font_families)[:200],
        "fontSizes": uniq(font_sizes)[:200],
        "fontWeights": uniq(font_weights)[:200],
        "lineHeights": uniq(line_heights)[:200],
        "colorLiterals": uniq(hex_colors + rgb_colors)[:500],
    }


def _srgb_to_linear(c: float) -> float:
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def relative_luminance(rgb: Tuple[int, int, int]) -> float:
    r, g, b = rgb
    R = _srgb_to_linear(r)
    G = _srgb_to_linear(g)
    B = _srgb_to_linear(b)
    return 0.2126 * R + 0.7152 * G + 0.0722 * B


def contrast_ratio(rgb1: Tuple[int, int, int], rgb2: Tuple[int, int, int]) -> float:
    L1 = relative_luminance(rgb1)
    L2 = relative_luminance(rgb2)
    lighter = max(L1, L2)
    darker = min(L1, L2)
    return (lighter + 0.05) / (darker + 0.05)


def hex_to_rgb(hex_color: str) -> Optional[Tuple[int, int, int]]:
    if not hex_color:
        return None
    h = hex_color.strip().lstrip("#")
    if len(h) == 3:
        h = "".join([c * 2 for c in h])
    if len(h) != 6:
        return None
    try:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except Exception:
        return None


def build_contrast_checks(palette_hex: List[str]) -> List[Dict]:
    # Approximation: test black/white on candidate background colors.
    checks = []
    fg_candidates = ["#000000", "#FFFFFF"]
    for bg in palette_hex[:8]:
        bg_rgb = hex_to_rgb(bg)
        if not bg_rgb:
            continue
        for fg in fg_candidates:
            fg_rgb = hex_to_rgb(fg)
            if not fg_rgb:
                continue
            ratio = contrast_ratio(fg_rgb, bg_rgb)
            checks.append({
                "fg": fg,
                "bg": bg,
                "ratio": round(ratio, 2),
                "passesAA": ratio >= 4.5,
                "passesAAA": ratio >= 7.0,
            })
    return checks


def choose_top_images(image_urls: List[str], limit: int = 10) -> List[str]:
    # Heuristic: prefer likely hero/banner images first.
    def score(u: str) -> int:
        ul = u.lower()
        s = 0
        for k in ["hero", "banner", "masthead", "header", "main", "home", "slide"]:
            if k in ul:
                s += 20
        for k in ["logo", "icon", "sprite", "badge", "award", "tracking", "pixel"]:
            if k in ul:
                s -= 20
        # prefer common photo formats
        if any(ul.endswith(ext) for ext in [".jpg", ".jpeg", ".png", ".webp"]):
            s += 5
        return s

    ranked = sorted(image_urls, key=score, reverse=True)
    # de-dupe while preserving order
    seen = set()
    out = []
    for u in ranked:
        if u in seen:
            continue
        seen.add(u)
        out.append(u)
        if len(out) >= limit:
            break
    return out


def scrape_brand_report(url: str) -> Dict:
    host = host_slug(url)
    stamp = now_stamp()
    out_dir = Path("out") / host / stamp
    assets_dir = out_dir / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    # 1) Rendered HTML
    html = fetch_rendered_html(url, wait_for="body")
    (out_dir / "page.html").write_text(html, encoding="utf-8")

    # 2) DOM + asset URLs
    dom = extract_dom(html, base_url=url)

    # 3) Screenshot
    screenshot_path = str(assets_dir / f"{host}_page.png")
    fetch_screenshot_png(url, out_path=screenshot_path, full_page=True)

    # 4) ZenRows JSON response (network insights)
    jr = fetch_json_response(url, wait_for="body")

    # 5) Download logo if raster (or store inline svg)
    logo_path = None
    logo_meta = None
    if dom.get("logo_url"):
        tmp = str(assets_dir / f"{host}_logo.bin")
        try:
            meta = download(dom["logo_url"], tmp)
            logo_meta = meta
            ext = SUPPORTED_CT.get(meta["content_type"])
            if ext and meta["bytes"] > 0:
                final = str(assets_dir / f"{host}_logo.{ext}")
                os.replace(tmp, final)
                logo_path = final
            else:
                # keep .bin for debugging, but don't palette it
                logo_path = None
        except Exception as e:
            logo_meta = {"error": str(e), "requested_url": dom.get("logo_url")}

    logo_svg_path = None
    if dom.get("logo_inline_svg"):
        logo_svg_path = str(assets_dir / f"{host}_logo.svg")
        Path(logo_svg_path).write_text(dom["logo_inline_svg"], encoding="utf-8")

    # 6) Download top images and compute palettes
    top_images = choose_top_images(dom.get("image_urls") or [], limit=10)
    downloaded_images = []
    palettes_by_image_url = {}

    for idx, img_url in enumerate(top_images):
        try:
            tmp = str(assets_dir / f"img_{idx}.bin")
            meta = download(img_url, tmp)
            ext = SUPPORTED_CT.get(meta["content_type"])
            if not ext or meta["bytes"] == 0:
                downloaded_images.append({**meta, "ok": False, "reason": "unsupported_content_type"})
                continue
            final = str(assets_dir / f"img_{idx}.{ext}")
            os.replace(tmp, final)
            meta["path"] = final
            downloaded_images.append({**meta, "ok": True})

            # palette per image
            pal = node_palette(final)
            palettes_by_image_url[img_url] = {
                "downloadedPath": final,
                "vibrant": pal.get("vibrant"),
            }
        except Exception as e:
            downloaded_images.append({"requested_url": img_url, "ok": False, "error": str(e)})

    # 7) Palettes for screenshot + logo (if supported)
    palette_from_screenshot = node_palette(screenshot_path)
    palette_from_logo = node_palette(logo_path) if logo_path else None

    # 8) CSS harvesting
    css_tokens = []
    stylesheet_urls = dom.get("stylesheet_urls") or []
    for css_url in stylesheet_urls[:10]:
        try:
            css_text = fetch_rendered_html(css_url, wait_for=None, block_resources=None)
            css_tokens.append({"css_url": css_url, **_parse_css_tokens(css_text)})
        except Exception as e:
            css_tokens.append({"css_url": css_url, "error": str(e)})

    # 9) Typography summary (approx)
    all_families = []
    all_sizes = []
    all_weights = []
    all_lines = []
    for t in css_tokens:
        if "error" in t:
            continue
        all_families += t.get("fontFamilies", [])
        all_sizes += t.get("fontSizes", [])
        all_weights += t.get("fontWeights", [])
        all_lines += t.get("lineHeights", [])

    def uniq(seq: List[str]) -> List[str]:
        seen = set()
        out = []
        for x in seq:
            x = x.strip()
            if not x or x in seen:
                continue
            seen.add(x)
            out.append(x)
        return out

    typography = {
        "fontFamilies": uniq(all_families)[:200],
        "fontSizes": uniq(all_sizes)[:200],
        "fontWeights": uniq(all_weights)[:200],
        "lineHeights": uniq(all_lines)[:200],
    }

    # 10) Contrast checks (approx from screenshot palette)
    palette_hex = (palette_from_screenshot.get("vibrant", {}) or {}).get("rankedHex", [])
    contrast_checks = build_contrast_checks(palette_hex)

    report = {
        "meta": {
            "engine": "zenrows",
            "scrapedAt": stamp,
            "url": url,
            "host": host,
        },
        "page": {
            "title": dom.get("title"),
            "h1": dom.get("h1"),
        },
        "assets": {
            "screenshotPath": screenshot_path,
            "screenshotSha256": sha256_file(screenshot_path),
            "logoPath": logo_path,
            "logoMeta": logo_meta,
            "logoInlineSvgPath": logo_svg_path,
            "images": downloaded_images,
            "videos": dom.get("video_urls") or [],
            "iframes": dom.get("iframe_urls") or [],
            "stylesheets": stylesheet_urls,
            "scripts": dom.get("script_urls") or [],
        },
        "palette": {
            "fromScreenshot": palette_from_screenshot,
            "fromLogo": palette_from_logo,
        },
        "palettesByImageUrl": palettes_by_image_url,
        "css": {
            "tokens": css_tokens,
        },
        "typography": typography,
        "contrastChecks": contrast_checks,
        "zenrows": {
            "raw_json_response": jr,
        },
    }

    # 11) Theme extraction + CSS build (best effort)
    # Set SKIP_THEME=1 to disable.
    if os.environ.get("SKIP_THEME", "0") not in ("1", "true", "TRUE"):
        report["theme"] = generate_theme_artifacts(url, out_dir)

    save_json(report, str(out_dir / "report.json"))
    return report


if __name__ == "__main__":
    import sys

    url = os.environ.get("SCRAPE_URL") or (sys.argv[1] if len(sys.argv) > 1 else "https://vivint.com/")
    r = scrape_brand_report(url)
    print("Saved report to:", Path("out") / host_slug(url))
    if isinstance(r.get("theme"), dict) and not r["theme"].get("error"):
        print("Theme json:", r["theme"].get("themeJsonPath"))
        print("Brand theme css:", r["theme"].get("brandCssPath"))

