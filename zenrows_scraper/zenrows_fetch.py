# zenrows_fetch.py

import os
import time
import random
import base64
import json
from pathlib import Path
from typing import Optional, Dict, Any

import requests
from dotenv import load_dotenv

load_dotenv()

ZENROWS_API_KEY = os.environ.get("ZENROWS_API_KEY")
if not ZENROWS_API_KEY:
    raise RuntimeError("ZENROWS_API_KEY not set in environment")

ZENROWS_ENDPOINT = "https://api.zenrows.com/v1/"
RETRY_STATUSES = {429, 500, 502, 503, 504}


# ------------------------------------------------------------
# Core request helper
# ------------------------------------------------------------
def zenrows_get(
    url: str,
    *,
    js_render: bool = False,
    premium_proxy: bool = False,
    wait_for: Optional[str] = None,
    block_resources: Optional[str] = None,
    json_response: bool = False,
    js_instructions: Optional[str] = None,
    screenshot: bool = False,
    screenshot_fullpage: bool = False,
    screenshot_format: str = "png",
    timeout_s: int = 45,
    max_retries: int = 3,
) -> requests.Response:
    params: Dict[str, str] = {
        "url": url,
        "apikey": ZENROWS_API_KEY,
    }

    if js_render:
        params["js_render"] = "true"
    if premium_proxy:
        params["premium_proxy"] = "true"
    if wait_for:
        params["wait_for"] = wait_for
    if block_resources:
        params["block_resources"] = block_resources
    if json_response:
        params["json_response"] = "true"
    if js_instructions:
        params["js_instructions"] = js_instructions
    if screenshot:
        params["screenshot"] = "true"
        params["screenshot_format"] = screenshot_format
        if screenshot_fullpage:
            params["screenshot_fullpage"] = "true"

    last_err: Optional[Exception] = None

    for attempt in range(max_retries):
        try:
            r = requests.get(ZENROWS_ENDPOINT, params=params, timeout=timeout_s)

            if r.status_code in RETRY_STATUSES:
                time.sleep(min(20, 2 ** attempt) + random.uniform(0, 0.5))
                continue

            r.raise_for_status()
            return r

        except Exception as e:
            last_err = e
            time.sleep(min(20, 2 ** attempt) + random.uniform(0, 0.5))

    raise RuntimeError(f"ZenRows request failed for {url}") from last_err


# ------------------------------------------------------------
# HTML fetch with plan-safe fallback ladder
# ------------------------------------------------------------
def fetch_rendered_html(
    url: str,
    *,
    wait_for: Optional[str] = None,
    js_instructions: Optional[str] = None,
    block_resources: Optional[str] = "image,media,font",
) -> str:
    """
    Fetch HTML with a fallback ladder. Accepts block_resources for CSS fetch use.
    """
    attempts = [
        dict(js_render=True, premium_proxy=True),
        dict(js_render=True, premium_proxy=False),
        dict(js_render=False, premium_proxy=False),
    ]

    last_err: Optional[Exception] = None
    for cfg in attempts:
        try:
            r = zenrows_get(
                url,
                js_render=cfg["js_render"],
                premium_proxy=cfg["premium_proxy"],
                wait_for=wait_for or "body",
                js_instructions=js_instructions,
                block_resources=block_resources,
                timeout_s=45,
                max_retries=2,
            )
            return r.text
        except Exception as e:
            last_err = e
            continue

    raise RuntimeError(f"Failed to fetch HTML for {url}") from last_err


# ------------------------------------------------------------
# Screenshot fetch with automatic size fallbacks (413-safe)
# ------------------------------------------------------------
def fetch_screenshot_png(
    url: str,
    out_path: str,
    *,
    wait_for: str = "body",
    full_page: bool = True,
) -> str:
    """
    Fetch screenshot via ZenRows.
    Automatically falls back to smaller payloads to avoid 413 errors.
    """
    attempts = [
        dict(full_page=full_page, fmt="png"),
        dict(full_page=full_page, fmt="jpeg"),
        dict(full_page=False, fmt="png"),
        dict(full_page=False, fmt="jpeg"),
    ]

    last_err: Optional[Exception] = None

    for a in attempts:
        try:
            r = zenrows_get(
                url,
                js_render=True,
                premium_proxy=False,  # avoid paid tier
                wait_for=wait_for,
                json_response=True,
                screenshot=True,
                screenshot_fullpage=a["full_page"],
                screenshot_format=a["fmt"],
                timeout_s=60,
                max_retries=2,
            )

            payload = r.json()
            b64 = payload.get("screenshot", {}).get("data")
            if not b64:
                raise RuntimeError("No screenshot data in response")

            img_bytes = base64.b64decode(b64)

            ext = "png" if a["fmt"] == "png" else "jpg"
            final_path = str(Path(out_path).with_suffix(f".{ext}"))

            p = Path(final_path)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(img_bytes)

            return final_path

        except Exception as e:
            last_err = e
            continue

    raise RuntimeError(f"Screenshot failed for {url}") from last_err


# ------------------------------------------------------------
# Optional: fetch JSON response only (no screenshot)
# ------------------------------------------------------------
def fetch_json_response(url: str, *, wait_for: Optional[str] = None) -> dict:
    r = zenrows_get(
        url,
        js_render=True,
        premium_proxy=False,
        wait_for=wait_for or "body",
        json_response=True,
        timeout_s=45,
        max_retries=2,
    )
    return r.json()
