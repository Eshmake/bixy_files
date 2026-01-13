# extract_dom.py
from bs4 import BeautifulSoup
from urllib.parse import urljoin

def extract_dom(html: str, base_url: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")

    title = soup.title.get_text(strip=True) if soup.title else None
    h1 = soup.find("h1")
    h1_text = h1.get_text(strip=True) if h1 else None

    # naive logo heuristic (you can improve per-site)
    logo = None
    for img in soup.find_all("img"):
        alt = (img.get("alt") or "").lower()
        src = img.get("src") or ""
        if "logo" in alt or "logo" in src.lower():
            logo = urljoin(base_url, src)
            break

    # hero-ish images (simple heuristic)
    images = []
    for img in soup.find_all("img"):
        src = img.get("src")
        if src:
            images.append(urljoin(base_url, src))
    images = images[:20]

    return {
        "title": title,
        "h1": h1_text,
        "logo_url": logo,
        "image_urls": images,
    }
