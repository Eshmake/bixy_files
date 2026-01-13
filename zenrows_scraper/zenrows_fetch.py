#zenrows_fetch.py

import os
import time
import random
import json
import base64
from pathlib import Path
from typing import Optional, Dict, Any

import requests
from dotenv import load_dotenv

# Load .env from current working directory (default). If your file is named key.env,
# either rename it to .env or do: load_dotenv("key.env")
load_dotenv()

ZENROWS_API_KEY = os.environ.get("ZENROWS_API_KEY")
if not ZENROWS_API_KEY:
    raise RuntimeError(
        "ZENROWS_API_KEY not found. Set it in your environment or in a .env file."
    )

ZENROWS_ENDPOINT = "https://api.zenrows.com/v1/"
RETRY_STATUSES = {429, 500, 502, 503, 504}


def zenrows_get(
    url: str,
    *,
    js_render: bool = True,
    premium_proxy: bool = True,
    wait_for: Optional[str] = None,
    wait_ms: Optional[int] = None,
    block_resources: Optional[str] = None,
    js_instructions: Optional[str] = None,
    css_extractor: Optional[Dict[str, Any]] = None,
    response_type: Optional[str] = None,
    # Screenshot / JSON response options
    json_response: bool = False,
    screenshot: bool = False,
    screenshot_fullpage: bool = True,
    screenshot_format: str = "png",
    # Network / retry options
    timeout_s: int = 45,
    max_retries: int = 5,
) -> requests.Response:
    """
    Low-level ZenRows request wrapper with retries.
    Returns the raw requests.Response.
    """
    params: Dict[str, str] = {
        "url": url,
        "apikey": ZENROWS_API_KEY,
        "js_render": "true" if js_render else "false",
        "premium_proxy": "true" if premium_proxy else "false",
    }

    if wait_for:
        params["wait_for"] = wait_for
    if wait_ms is not None:
        params["wait"] = str(wait_ms)
    if block_resources:
        params["block_resources"] = block_resources
    if js_instructions:
        params["js_instructions"] = js_instructions
    if css_extractor:
        params["css_extractor"] = json.dumps(css_extractor)
    if response_type:
        params["response_type"] = response_type

    # JSON response + screenshot flags
    if json_response:
        params["json_response"] = "true"
    if screenshot:
        params["screenshot"] = "true"
        params["screenshot_fullpage"] = "true" if screenshot_fullpage else "false"
        params["screenshot_format"] = screenshot_format

    last_err: Optional[Exception] = None
    for attempt in range(max_retries):
        try:
            r = requests.get(ZENROWS_ENDPOINT, params=params, timeout=timeout_s)

            if r.status_code in RETRY_STATUSES:
                # exponential backoff + jitter
                sleep_s = min(20, (2 ** attempt)) + random.uniform(0, 0.5)
                time.sleep(sleep_s)
                continue

            r.raise_for_status()
            return r

        except Exception as e:
            last_err = e
            sleep_s = min(20, (2 ** attempt)) + random.uniform(0, 0.5)
            time.sleep(sleep_s)

    raise RuntimeError(f"ZenRows failed for {url}") from last_err


def fetch_rendered_html(url: str, *, wait_for: Optional[str] = None) -> str:
    """
    Fetch fully rendered HTML for a page (good Puppeteer replacement for page.content()).
    """
    r = zenrows_get(
        url,
        js_render=True,
        premium_proxy=True,
        wait_for=wait_for or "body",
        # Speed/cost optimization for HTML-only scraping:
        block_resources="image,media,font",
        timeout_s=45,
        max_retries=5,
    )
    return r.text


def fetch_screenshot_png(
    url: str,
    out_path: str = "out/screenshot.png",
    *,
    wait_for: str = "body",
    full_page: bool = True,
) -> str:
    """
    Fetch a rendered screenshot (PNG) via ZenRows and save it to disk.
    Returns the output path.
    """
    # For screenshots, don't block images; you want the page to actually render.
    r = zenrows_get(
        url,
        js_render=True,
        premium_proxy=True,
        wait_for=wait_for,
        block_resources=None,
        json_response=True,
        screenshot=True,
        screenshot_fullpage=full_page,
        screenshot_format="png",
        timeout_s=60,
        max_retries=5,
    )

    payload = r.json()

    # Most common format: payload["screenshot"]["data"] is base64.
    # If ZenRows changes response shape on your plan, print(payload.keys()) once.
    try:
        b64 = payload["screenshot"]["data"]
    except Exception as e:
        raise RuntimeError(
            f"Unexpected screenshot payload shape. Keys: {list(payload.keys())}"
        ) from e

    img_bytes = base64.b64decode(b64)

    path = Path(out_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(img_bytes)

    return str(path)
