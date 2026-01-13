# run_brand_scrape.py
import os
import requests
from zenrows_fetch import fetch_rendered_html
from extract_dom import extract_dom

import json
from urllib.parse import urlparse
from pathlib import Path

def save_json(data: dict, url: str, out_dir: str = "out"):
    Path(out_dir).mkdir(parents=True, exist_ok=True)

    host = urlparse(url).netloc.replace("www.", "")
    out_path = Path(out_dir) / f"{host}.json"

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    return str(out_path)

def download(url: str, out_path: str):
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    with open(out_path, "wb") as f:
        f.write(r.content)

def scrape_brand(url: str) -> dict:
    html = fetch_rendered_html(url, wait_for="body")
    data = extract_dom(html, base_url=url)

    if data.get("logo_url"):
        os.makedirs("out/assets", exist_ok=True)
        print("Downloading logo_url:", data["logo_url"])
        download(data["logo_url"], "out/assets/logo.png")
        print("Saved logo.png bytes:", os.path.getsize("out/assets/logo.png"))

    save_path = save_json(data, url)
    print("Saved JSON to:", save_path)

    return data

if __name__ == "__main__":
    print(scrape_brand("https://toyota.com/"))

