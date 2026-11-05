#!/usr/bin/env python3
"""
Завантажує останні 20 постів із публічного Telegram-каналу
через парсинг публічної веб-версії t.me/s/<channel>
та зберігає в data/telegram_posts.json
"""

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import requests
from bs4 import BeautifulSoup

CHANNEL    = "avtonomka_od"
CHANNEL_URL = f"https://t.me/s/{CHANNEL}"
OUTPUT_FILE = Path(__file__).parent.parent / "data" / "telegram_posts.json"
MAX_POSTS   = 30

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    ),
    "Accept-Language": "uk,en;q=0.9",
}


def fetch_html(url: str) -> str:
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.text


def parse_posts(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    posts = []

    for msg in soup.select(".tgme_widget_message"):
        # Post id
        post_id_raw = msg.get("data-post", "")
        post_id = post_id_raw.split("/")[-1] if "/" in post_id_raw else post_id_raw

        # URL
        url = f"https://telegram.me/{CHANNEL}/{post_id}" if post_id else CHANNEL_URL

        # Date
        time_el = msg.select_one(".tgme_widget_message_date time")
        date_str = ""
        if time_el:
            date_str = time_el.get("datetime", "")

        # Text
        text_el = msg.select_one(".tgme_widget_message_text")
        text = ""
        if text_el:
            # Replace <br> with newlines before getting text
            for br in text_el.find_all("br"):
                br.replace_with("\n")
            text = text_el.get_text(separator=" ").strip()
            text = re.sub(r"\s{2,}", " ", text)

        # Photo
        photo = ""
        photo_el = msg.select_one(".tgme_widget_message_photo_wrap")
        if photo_el:
            style = photo_el.get("style", "")
            m = re.search(r"url\(['\"]?(https?://[^'\")\s]+)['\"]?\)", style)
            if m:
                photo = m.group(1)

        if not text and not photo:
            continue

        posts.append({
            "id":    post_id,
            "text":  text,
            "date":  date_str,
            "photo": photo,
            "url":   url,
        })

    return posts


def main() -> int:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Завантаження постів з {CHANNEL_URL}…")
    try:
        html = fetch_html(CHANNEL_URL)
    except requests.RequestException as exc:
        print(f"ПОМИЛКА: {exc}", file=sys.stderr)
        return 1

    posts = parse_posts(html)

    # Sort by post id descending (newest first), limit
    posts.sort(key=lambda p: int(p["id"]) if p["id"].isdigit() else 0, reverse=True)
    posts = posts[:MAX_POSTS]

    print(f"  Знайдено постів: {len(posts)}")

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(
        json.dumps(posts, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"  Збережено → {OUTPUT_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
