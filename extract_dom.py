# extract_dom.py
# Extracts a richer set of assets from rendered HTML so the ZenRows pipeline can
# approximate (and eventually replace) the Puppeteer pipeline.

from __future__ import annotations

from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse
from typing import Dict, List, Optional, Set, Tuple

TRACKER_HOST_SUBSTRINGS = [
    "google-analytics.com",
    "tealiumiq.com",
    "doubleclick.net",
    "googletagmanager.com",
    "facebook.com/tr",
    "connect.facebook.net",
]


def _is_tracker(url: str) -> bool:
    u = (url or "").lower()
    return any(t in u for t in TRACKER_HOST_SUBSTRINGS)


def _same_domain(asset_url: str, base_url: str) -> bool:
    try:
        a = urlparse(asset_url)
        b = urlparse(base_url)
        if not a.netloc:
            return True
        host = a.netloc.lower().replace("www.", "")
        base_host = b.netloc.lower().replace("www.", "")
        return host.endswith(base_host)
    except Exception:
        return False


def _dedupe(urls: List[str]) -> List[str]:
    seen = set()
    out = []
    for u in urls:
        if not u or u in seen:
            continue
        seen.add(u)
        out.append(u)
    return out


def _pick_logo_img(soup: BeautifulSoup, base_url: str, brand_hint: str) -> Optional[str]:
    brand_hint = (brand_hint or "").lower()

    def score(img) -> int:
        # NOTE: some sites use data-src for lazy loaded logos; include both
        src = (img.get("src") or img.get("data-src") or img.get("data-lazy-src") or "").strip()
        if not src:
            return -999

        full = urljoin(base_url, src)
        if _is_tracker(full):
            return -999

        alt = (img.get("alt") or "").lower()
        title = (img.get("title") or "").lower()
        cls = " ".join(img.get("class") or []).lower()
        full_l = full.lower()

        s = 0
        if img.find_parent(["header", "nav"]) is not None:
            s += 50
        if brand_hint and (brand_hint in alt or brand_hint in title or brand_hint in full_l):
            s += 40
        if "logo" in alt or "logo" in title or "logo" in cls or "logo" in full_l:
            s += 20

        # Penalize obvious review/award badges
        for bad in ["pcmag", "nerdwallet", "cybernews", "award", "badge", "review", "trustpilot"]:
            if bad in full_l:
                s -= 25

        # Prefer same-domain
        if _same_domain(full, base_url):
            s += 10

        return s

    best_url = None
    best_score = -999
    for img in soup.find_all("img"):
        sc = score(img)
        if sc > best_score:
            best_score = sc
            src = (img.get("src") or img.get("data-src") or img.get("data-lazy-src") or "").strip()
            best_url = urljoin(base_url, src)

    return best_url if best_score >= 0 else None


def _pick_inline_logo_svg(soup: BeautifulSoup) -> Optional[str]:
    # Many modern sites (e.g., Vivint) use an inline SVG for the primary logo.
    # We return the outer HTML of the best candidate.
    candidates = []
    for svg in soup.find_all("svg"):
        cls = " ".join(svg.get("class") or []).lower()
        sid = (svg.get("id") or "").lower()
        aria = (svg.get("aria-label") or "").lower()
        if "logo" in cls or "logo" in sid or "logo" in aria:
            candidates.append(svg)

    if not candidates:
        return None

    # Prefer ones inside header/nav
    def svg_score(svg) -> int:
        s = 0
        if svg.find_parent(["header", "nav"]) is not None:
            s += 50
        # prefer ones with <title>
        if svg.find("title") is not None:
            s += 10
        return s

    candidates.sort(key=svg_score, reverse=True)
    return str(candidates[0])


def _normalize_media_url(u: str, base_url: str) -> Optional[str]:
    if not u:
        return None
    u = u.strip()
    if not u:
        return None
    # ignore data URIs
    if u.startswith("data:"):
        return None
    return urljoin(base_url, u)


def _collect_video_urls(soup: BeautifulSoup, base_url: str) -> Tuple[List[str], List[dict]]:
    """
    Returns:
      (direct_video_urls, embed_objects)

    direct_video_urls: mp4/webm/etc we can download directly.
    embed_objects: youtube/vimeo/vidyard/etc metadata.
    """
    direct: Set[str] = set()
    embeds: List[dict] = []

    # 1) <video> tags: Vivint uses data-* breakpoints like data-d1600/data-m... and <source data-src=...>
    for v in soup.find_all("video"):
        # src + common lazy attrs
        candidates = []

        # direct src
        candidates.append(v.get("src"))

        # common lazy/source attrs
        for attr in [
            "data-src",
            "data-source",
            "data-video",
            "data-video-src",
            "data-mp4",
            "data-webm",
            "data-d1600",
            "data-t768",
            "data-m521",
            "data-m415",
            "data-m",
        ]:
            candidates.append(v.get(attr))

        # also grab any data-* that looks like a video file
        for k, val in (v.attrs or {}).items():
            if not isinstance(k, str):
                continue
            if not (k.startswith("data-")):
                continue
            if isinstance(val, str) and (".mp4" in val.lower() or ".webm" in val.lower() or ".m3u8" in val.lower()):
                candidates.append(val)

        for c in candidates:
            nu = _normalize_media_url(c or "", base_url)
            if not nu:
                continue
            if any(ext in nu.lower() for ext in [".mp4", ".webm", ".m3u8", ".mov"]):
                direct.add(nu)

        for source in v.find_all("source"):
            scands = [
                source.get("src"),
                source.get("data-src"),
                source.get("data-source"),
            ]
            for c in scands:
                nu = _normalize_media_url(c or "", base_url)
                if not nu:
                    continue
                if any(ext in nu.lower() for ext in [".mp4", ".webm", ".m3u8", ".mov"]):
                    direct.add(nu)

    # 2) <a href="...mp4"> or <source> may not exist; sometimes mp4 is in links
    for a in soup.find_all("a"):
        href = a.get("href")
        nu = _normalize_media_url(href or "", base_url)
        if not nu:
            continue
        if any(ext in nu.lower() for ext in [".mp4", ".webm", ".m3u8", ".mov"]):
            direct.add(nu)

    # 3) Vidyard: Vivint uses data-vid-uuid on <img> thumbnails + includes play.vidyard.com/embed/v4.js
    # Example: data-vid-uuid="CAhSPi3XmVQifFkd6Dz9oH"
    for tag in soup.find_all(attrs={"data-vid-uuid": True}):
        uuid = (tag.get("data-vid-uuid") or "").strip()
        if not uuid:
            continue
        # Thumb (often data-src=...jpg)
        thumb = tag.get("data-src") or tag.get("src")
        thumb_u = _normalize_media_url(thumb or "", base_url)
        embeds.append({
            "type": "vidyard",
            "uuid": uuid,
            # this is a commonly-usable embed URL (works for many public vidyard players)
            "embedUrl": f"https://play.vidyard.com/{uuid}.html",
            "thumbUrl": thumb_u,
        })

    # 4) Meta tags that sometimes expose video URLs
    for m in soup.find_all("meta"):
        prop = (m.get("property") or m.get("name") or "").lower()
        if prop in ["og:video", "og:video:url", "twitter:player", "twitter:player:stream"]:
            content = m.get("content")
            nu = _normalize_media_url(content or "", base_url)
            if nu and any(ext in nu.lower() for ext in [".mp4", ".webm", ".m3u8", ".mov"]):
                direct.add(nu)
            elif nu:
                embeds.append({"type": "meta", "property": prop, "url": nu})

    return _dedupe(list(direct)), embeds


def extract_dom(html: str, base_url: str) -> Dict:
    soup = BeautifulSoup(html, "html.parser")

    title = soup.title.get_text(strip=True) if soup.title else None
    h1 = soup.find("h1")
    h1_text = h1.get_text(strip=True) if h1 else None

    brand_hint = urlparse(base_url).netloc.replace("www.", "").split(".")[0]

    logo_url = _pick_logo_img(soup, base_url, brand_hint)
    logo_inline_svg = _pick_inline_logo_svg(soup)

    # Images: include img tags (same-domain + non-tracker preferred)
    image_urls: List[str] = []
    for img in soup.find_all("img"):
        src = (img.get("src") or img.get("data-src") or img.get("data-lazy-src") or "").strip()
        if not src:
            continue
        full = urljoin(base_url, src)
        if _is_tracker(full):
            continue
        image_urls.append(full)

    image_urls = _dedupe(image_urls)

    # Stylesheets
    stylesheet_urls: List[str] = []
    for link in soup.find_all("link"):
        rel = " ".join(link.get("rel") or []).lower()
        href = link.get("href")
        if not href:
            continue
        if "stylesheet" in rel:
            stylesheet_urls.append(urljoin(base_url, href))

    stylesheet_urls = _dedupe(stylesheet_urls)

    # Scripts
    script_urls: List[str] = []
    for s in soup.find_all("script"):
        src = s.get("src")
        if src:
            script_urls.append(urljoin(base_url, src))

    script_urls = _dedupe(script_urls)

    # Videos / iframes
    video_urls, video_embeds = _collect_video_urls(soup, base_url)

    iframe_urls: List[str] = []
    for fr in soup.find_all("iframe"):
        src = fr.get("src")
        if src:
            iframe_urls.append(urljoin(base_url, src))

    iframe_urls = _dedupe(iframe_urls)

    return {
        "title": title,
        "h1": h1_text,
        "logo_url": logo_url,
        "logo_inline_svg": logo_inline_svg,
        "image_urls": image_urls,
        "stylesheet_urls": stylesheet_urls,
        "script_urls": script_urls,
        "video_urls": video_urls,
        "video_embeds": video_embeds,
        "iframe_urls": iframe_urls,
    }
