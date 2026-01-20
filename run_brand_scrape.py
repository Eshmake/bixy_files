# zenrows_scraper/run_brand_scrape.py
#
# Brand scrape runner:
# - Uses ZenRows to fetch rendered HTML + a screenshot
# - Extracts logo/images/videos from the HTML
# - Runs node-vibrant (via palette.cjs) on screenshot/logo/images
# - Writes output to: out/<host>/<YYYYMMDD_HHMMSS>/report.json + assets/*
#
# Requirements:
#   pip3 install requests beautifulsoup4 python-dotenv
#   npm i node-vibrant colord
#
# Files expected in zenrows_scraper/:
#   - zenrows_fetch.py
#   - extract_dom.py
#   - palette.cjs
#
# .env expected at repo root (one level above zenrows_scraper/):
#   ZENROWS_API_KEY=xxxx

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv

from zenrows_fetch import fetch_rendered_html, fetch_screenshot_png, fetch_json_response
from extract_dom import extract_dom

# ---------- config ----------
MAX_IMAGES_TO_DOWNLOAD = 10
MAX_VIDEOS_TO_DOWNLOAD = 2
VIDEO_MAX_BYTES = 35 * 1024 * 1024  # 35MB cap (prevents huge downloads)


# ---------- helpers ----------
def host_slug(url: str) -> str:
    return urlparse(url).netloc.replace("www.", "").strip()


def now_stamp() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def uniq(seq: List[str]) -> List[str]:
    seen = set()
    out = []
    for x in seq:
        x = (x or "").strip()
        if not x or x in seen:
            continue
        seen.add(x)
        out.append(x)
    return out


def choose_top_images(image_urls: List[str], limit: int = MAX_IMAGES_TO_DOWNLOAD) -> List[str]:
    # Simple heuristic: prefer likely hero/banner imagery and de-prioritize icons/badges/logos.
    def score(u: str) -> int:
        ul = u.lower()
        s = 0
        for good in ["hero", "banner", "masthead", "header", "main", "home", "slide", "carousel"]:
            if good in ul:
                s += 20
        for bad in ["logo", "icon", "sprite", "badge", "award", "pixel", "tracking"]:
            if bad in ul:
                s -= 20
        if any(ul.endswith(ext) for ext in [".jpg", ".jpeg", ".png", ".webp"]):
            s += 5
        return s

    ranked = sorted(image_urls, key=score, reverse=True)
    return ranked[:limit]


def choose_top_videos(video_urls: List[str], limit: int = MAX_VIDEOS_TO_DOWNLOAD) -> List[str]:
    # Prefer direct mp4/webm. De-prioritize manifests.
    def score(u: str) -> int:
        ul = u.lower()
        s = 0
        if ".mp4" in ul:
            s += 50
        if ".webm" in ul:
            s += 30
        if ".m3u8" in ul:
            s -= 10
        for good in ["hero", "ambient", "banner", "masthead"]:
            if good in ul:
                s += 10
        return s

    ranked = sorted(video_urls, key=score, reverse=True)
    return ranked[:limit]


def save_json(path: Path, data: dict) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def download(url: str, out_path: Path, timeout: int = 30) -> dict:
    r = requests.get(
        url,
        timeout=timeout,
        allow_redirects=True,
        headers={"User-Agent": "Mozilla/5.0", "Accept": "*/*"},
    )
    r.raise_for_status()
    ensure_dir(out_path.parent)
    out_path.write_bytes(r.content)

    ct = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    return {
        "requested_url": url,
        "final_url": r.url,
        "status": r.status_code,
        "content_type": ct,
        "bytes": len(r.content),
        "path": str(out_path),
    }


def download_stream_capped(url: str, out_path: Path, max_bytes: int = VIDEO_MAX_BYTES) -> dict:
    headers = {
        "User-Agent": "Mozilla/5.0",
        "Accept": "*/*",
        "Range": f"bytes=0-{max_bytes - 1}",
    }
    r = requests.get(url, timeout=60, allow_redirects=True, headers=headers, stream=True)
    r.raise_for_status()

    ensure_dir(out_path.parent)
    total = 0
    with open(out_path, "wb") as f:
        for chunk in r.iter_content(chunk_size=1024 * 256):
            if not chunk:
                continue
            total += len(chunk)
            if total > max_bytes:
                break
            f.write(chunk)

    ct = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    return {
        "requested_url": url,
        "final_url": r.url,
        "status": r.status_code,
        "content_type": ct,
        "bytes": total,
        "path": str(out_path),
        "capped": True,
        "max_bytes": max_bytes,
    }


def guess_ext_from_content_type(ct: str, fallback_url: str = "") -> Optional[str]:
    ct = (ct or "").lower()
    mapping = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
        "video/mp4": "mp4",
        "video/webm": "webm",
        "application/vnd.apple.mpegurl": "m3u8",
        "application/x-mpegurl": "m3u8",
    }
    if ct in mapping:
        return mapping[ct]

    ul = (fallback_url or "").lower()
    for ext in ["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm", "m3u8"]:
        if f".{ext}" in ul:
            return "jpg" if ext == "jpeg" else ext
    return None


def node_palette(image_path: str) -> dict:
    # ALWAYS reference palette.cjs inside zenrows_scraper/
    palette_path = Path(__file__).resolve().parent / "palette.cjs"
    if not palette_path.exists():
        raise FileNotFoundError(f"palette.cjs not found at: {palette_path}")

    p = subprocess.run(
        ["node", str(palette_path), image_path],
        capture_output=True,
        text=True,
        check=False,
    )
    if p.returncode != 0:
        raise RuntimeError(
            "palette.cjs failed:\n"
            f"CMD: node {palette_path} {image_path}\n"
            f"STDOUT:\n{p.stdout}\n"
            f"STDERR:\n{p.stderr}\n"
        )
    return json.loads(p.stdout)


# ---------- main scrape ----------
def scrape_brand_report(url: str) -> dict:
    # Load .env from repo root (one level above zenrows_scraper/)
    repo_root = Path(__file__).resolve().parents[1]
    load_dotenv(repo_root / ".env")

    host = host_slug(url)
    stamp = now_stamp()

    out_dir = repo_root / "out" / host / stamp
    assets_dir = out_dir / "assets"
    videos_dir = assets_dir / "videos"
    ensure_dir(assets_dir)
    ensure_dir(videos_dir)

    print(f"[1/8] Fetching rendered HTML: {url}")
    html = fetch_rendered_html(url, wait_for="body")
    (out_dir / "page.html").write_text(html, encoding="utf-8")

    print("[2/8] Extracting DOM assets (logo/images/videos/embeds)")
    dom = extract_dom(html, base_url=url)

    print("[3/8] Capturing full-page screenshot")
    screenshot_path = assets_dir / f"{host}_page.png"
    fetch_screenshot_png(url, out_path=str(screenshot_path), full_page=True)

    print("[4/8] Running palette on screenshot")
    palette_from_screenshot = node_palette(str(screenshot_path))

    # Download logo (if URL logo exists) and/or save inline svg if present
    logo_path = None
    logo_inline_svg_path = None
    logo_meta = None

    if dom.get("logo_url"):
        print("[5/8] Downloading logo")
        tmp_logo = assets_dir / f"{host}_logo.bin"
        try:
            meta = download(dom["logo_url"], tmp_logo)
            ext = guess_ext_from_content_type(meta.get("content_type", ""), meta.get("final_url", dom["logo_url"]))
            if ext:
                final_logo = assets_dir / f"{host}_logo.{ext}"
                tmp_logo.replace(final_logo)
                logo_path = final_logo
                meta["path"] = str(final_logo)
            else:
                # keep bin, but mark as unsupported
                logo_path = tmp_logo
                meta["note"] = "Unsupported content type; kept as .bin"
            logo_meta = meta
        except Exception as e:
            logo_meta = {"requested_url": dom.get("logo_url"), "error": str(e)}

    if dom.get("logo_inline_svg"):
        print("[5/8] Saving inline SVG logo")
        logo_inline_svg_path = assets_dir / f"{host}_logo.svg"
        logo_inline_svg_path.write_text(dom["logo_inline_svg"], encoding="utf-8")

    palette_from_logo = None
    if logo_path and logo_path.exists():
        # Only run palette on raster images
        if logo_path.suffix.lower() in [".png", ".jpg", ".jpeg", ".webp", ".gif"]:
            try:
                palette_from_logo = node_palette(str(logo_path))
            except Exception:
                palette_from_logo = None

    # Download and palette top images
    print("[6/8] Downloading top images + palettes")
    top_images = choose_top_images(dom.get("image_urls") or [], limit=MAX_IMAGES_TO_DOWNLOAD)

    downloaded_images = []
    palettes_by_image_url = {}

    for idx, img_url in enumerate(top_images):
        try:
            tmp = assets_dir / f"img_{idx}.bin"
            meta = download(img_url, tmp)
            ext = guess_ext_from_content_type(meta.get("content_type", ""), meta.get("final_url", img_url))
            if not ext:
                downloaded_images.append({**meta, "ok": False, "reason": "unsupported_content_type"})
                continue

            final = assets_dir / f"img_{idx}.{ext}"
            tmp.replace(final)
            meta["path"] = str(final)
            downloaded_images.append({**meta, "ok": True})

            if ext in ["png", "jpg", "jpeg", "webp", "gif"]:
                pal = node_palette(str(final))
                palettes_by_image_url[img_url] = {"downloadedPath": str(final), "vibrant": pal.get("vibrant")}
        except Exception as e:
            downloaded_images.append({"requested_url": img_url, "ok": False, "error": str(e)})

    # Videos: store URLs + try downloading a couple if they are direct mp4/webm
    print("[7/8] Processing video URLs (direct + embeds)")
    video_urls = dom.get("video_urls") or []
    top_videos = choose_top_videos(video_urls, limit=MAX_VIDEOS_TO_DOWNLOAD)

    downloaded_videos = []
    for vid_i, vid_url in enumerate(top_videos):
        try:
            tmp = videos_dir / f"video_{vid_i}.bin"
            meta = download_stream_capped(vid_url, tmp, max_bytes=VIDEO_MAX_BYTES)
            ext = guess_ext_from_content_type(meta.get("content_type", ""), meta.get("final_url", vid_url))

            if ext:
                final = videos_dir / f"video_{vid_i}.{ext}"
                tmp.replace(final)
                meta["path"] = str(final)
                meta["ok"] = True
            else:
                meta["ok"] = False
                meta["reason"] = "unsupported_or_unknown_content_type"

            downloaded_videos.append(meta)
        except Exception as e:
            downloaded_videos.append({"requested_url": vid_url, "ok": False, "error": str(e)})

    # ZenRows raw JSON (optional but helpful for debugging)
    print("[8/8] Fetching ZenRows JSON response")
    try:
        jr = fetch_json_response(url, wait_for="body")
    except Exception as e:
        jr = {"error": str(e)}

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
            "pageHtmlPath": str(out_dir / "page.html"),
            "screenshotPath": str(screenshot_path),
            "logoUrl": dom.get("logo_url"),
            "logoPath": str(logo_path) if logo_path else None,
            "logoMeta": logo_meta,
            "logoInlineSvgPath": str(logo_inline_svg_path) if logo_inline_svg_path else None,
            "images": downloaded_images,
            "videos": video_urls,
            "downloadedVideos": downloaded_videos,
            "videoEmbeds": dom.get("video_embeds") or [],
            "iframes": dom.get("iframe_urls") or [],
            "stylesheets": dom.get("stylesheet_urls") or [],
            "scripts": dom.get("script_urls") or [],
        },
        "palette": {
            "fromScreenshot": palette_from_screenshot,
            "fromLogo": palette_from_logo,
        },
        "palettesByImageUrl": palettes_by_image_url,
        "zenrows": {
            "raw_json_response": jr,
        },
    }

    save_json(out_dir / "report.json", report)
    print(f"✅ Saved report to: {out_dir}")
    return report


if __name__ == "__main__":
    import sys

    # Default to Toyota if no arg passed
    target_url = sys.argv[1] if len(sys.argv) > 1 else "https://toyota.com/"
    scrape_brand_report(target_url)
