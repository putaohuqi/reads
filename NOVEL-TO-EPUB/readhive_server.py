#!/usr/bin/env python3
"""
ReadHive → EPUB local server
Runs on http://localhost:7842 and is used by epub.html.

Start with:  python3 NOVEL-TO-EPUB/readhive_server.py
Stop with:   Ctrl-C
"""

import json
import os
import re
import time
import uuid
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from ebooklib import epub
from flask import Flask, Response, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

PORT = 7842

# ─── Scraping helpers ─────────────────────────────────────────────────────────

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}


def parse_series_url(url: str) -> str | None:
    m = re.search(r"readhive\.org/series/(\d+)", url)
    return m.group(1) if m else None


def fetch_series_info(series_id: str) -> tuple[str, str, str, int]:
    url = f"https://readhive.org/series/{series_id}/"
    r = requests.get(url, headers=HEADERS, timeout=15)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    title = (soup.find("h1") or soup.find("h2") or soup.new_tag("x")).get_text(strip=True)

    author = ""
    for tag in soup.find_all(string=re.compile(r"Author", re.I)):
        parent = tag.parent
        sib = parent.find_next_sibling()
        if sib:
            author = sib.get_text(strip=True)
            break

    desc = ""
    for sel in ["[class*='synopsis']", "[class*='description']", "[class*='summary']"]:
        el = soup.select_one(sel)
        if el:
            desc = el.get_text(strip=True)
            break

    chapter_links = set()
    for a in soup.find_all("a", href=True):
        m = re.search(rf"/series/{series_id}/(\d+)/?$", a["href"])
        if m:
            chapter_links.add(int(m.group(1)))

    total = max(chapter_links) if chapter_links else 0
    return title, author, desc, total


def fetch_chapter(series_id: str, chapter_num: int) -> tuple[str, str]:
    url = f"https://readhive.org/series/{series_id}/{chapter_num}/"
    r = requests.get(url, headers=HEADERS, timeout=15)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    page_title = soup.title.string if soup.title else f"Chapter {chapter_num}"
    chapter_title = re.sub(r"\s*[–—-]\s*Readhive.*$", "", page_title).strip()
    if not chapter_title:
        chapter_title = f"Chapter {chapter_num}"

    content_el = soup.select_one(".prose") or soup.find("main")
    if content_el:
        for nav in content_el.find_all(["nav", "a", "button"]):
            nav.decompose()
        html = str(content_el)
    else:
        html = "<p>Content not found.</p>"

    return chapter_title, html


# ─── EPUB helpers ─────────────────────────────────────────────────────────────

def read_epub_chapters(epub_path: str) -> list[tuple[str, str]]:
    """Extract (title, html_content) from an existing epub, stripping the h2 wrapper."""
    book = epub.read_epub(epub_path)
    chapters = []
    for item in book.get_items():
        if not isinstance(item, epub.EpubHtml):
            continue
        if not item.file_name.startswith("chapter_"):
            continue
        content = item.content
        if isinstance(content, bytes):
            content = content.decode("utf-8")
        # Strip the <h2> title wrapper that build_epub added
        soup = BeautifulSoup(content, "html.parser")
        h2 = soup.find("h2")
        if h2:
            h2.decompose()
        chapters.append((item.title, str(soup)))
    return chapters


def build_epub(title: str, author: str, description: str,
               chapters: list[tuple[str, str]], output_path: str) -> None:
    book = epub.EpubBook()
    book.set_identifier(str(uuid.uuid4()))
    book.set_title(title)
    book.set_language("en")
    if author:
        book.add_author(author)

    style = epub.EpubItem(
        uid="style",
        file_name="style/main.css",
        media_type="text/css",
        content=(
            "body { font-family: Georgia, serif; font-size: 1em; "
            "line-height: 1.7; margin: 1em 2em; }\n"
            "h1, h2 { font-family: sans-serif; }\n"
            "p { margin: 0.6em 0; text-indent: 1.5em; }\n"
        ),
    )
    book.add_item(style)

    if description:
        intro = epub.EpubHtml(title="About", file_name="intro.xhtml", lang="en")
        intro.content = f"<h1>{title}</h1><p>{description}</p>"
        intro.add_item(style)
        book.add_item(intro)
        spine = ["nav", intro]
        toc = [epub.Link("intro.xhtml", "About", "intro")]
    else:
        spine = ["nav"]
        toc = []

    for i, (ch_title, ch_html) in enumerate(chapters):
        fname = f"chapter_{i+1:04d}.xhtml"
        ch = epub.EpubHtml(title=ch_title, file_name=fname, lang="en")
        ch.content = f"<h2>{ch_title}</h2>{ch_html}"
        ch.add_item(style)
        book.add_item(ch)
        spine.append(ch)
        toc.append(epub.Link(fname, ch_title, f"ch{i+1}"))

    book.toc = toc
    book.spine = spine
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    epub.write_epub(output_path, book)


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.post("/fetch-info")
def route_fetch_info():
    data = request.get_json(force=True)
    url = (data or {}).get("url", "").strip()
    if not url:
        return "missing url", 400
    series_id = parse_series_url(url)
    if not series_id:
        return "could not find series ID in URL", 400
    try:
        title, author, desc, total = fetch_series_info(series_id)
    except Exception as e:
        return str(e), 502
    return {"series_id": series_id, "title": title, "author": author,
            "description": desc, "total_chapters": total}


@app.post("/download")
def route_download():
    data = request.get_json(force=True) or {}
    series_id = data.get("series_id", "").strip()
    from_ch = int(data.get("from_ch", 1))
    to_ch = int(data.get("to_ch", 1))
    delay = float(data.get("delay", 1.0))
    title = data.get("title", f"series_{series_id}")
    merge_path = data.get("merge_path", "").strip()
    original_from_ch = int(data.get("original_from_ch", from_ch))

    if not series_id:
        return "missing series_id", 400

    def generate():
        # ── load existing epub if merging ──
        existing_chapters = []
        effective_from_ch = from_ch  # what to report back as the epub's start

        if merge_path and os.path.isfile(merge_path):
            try:
                existing_chapters = read_epub_chapters(merge_path)
                effective_from_ch = original_from_ch
                yield json.dumps({
                    "type": "info",
                    "message": f"loaded {len(existing_chapters)} existing chapters from epub"
                }) + "\n"
            except Exception as e:
                yield json.dumps({
                    "type": "info",
                    "message": f"could not read existing epub ({e}) — saving new file instead"
                }) + "\n"
        elif merge_path:
            yield json.dumps({
                "type": "info",
                "message": "existing epub not found — saving new file instead"
            }) + "\n"

        # ── download new chapters ──
        new_chapters = []
        total = to_ch - from_ch + 1

        for i, ch_num in enumerate(range(from_ch, to_ch + 1)):
            try:
                ch_title, ch_html = fetch_chapter(series_id, ch_num)
                new_chapters.append((ch_title, ch_html))
                yield json.dumps({
                    "type": "progress",
                    "current": i + 1,
                    "total": total,
                    "chapter_title": ch_title,
                }) + "\n"
            except Exception:
                yield json.dumps({"type": "skip", "chapter": ch_num}) + "\n"

            if i < total - 1:
                time.sleep(delay)

        # ── build epub ──
        all_chapters = existing_chapters + new_chapters
        safe_title = re.sub(r'[\\/*?:"<>|]', "_", title)

        if existing_chapters and merge_path:
            # Save with updated chapter range, in same folder as original
            output_path = str(
                Path(merge_path).parent / f"{safe_title} Ch{effective_from_ch}-{to_ch}.epub"
            )
        else:
            output_path = str(
                Path.home() / "Desktop" / f"{safe_title} Ch{from_ch}-{to_ch}.epub"
            )

        try:
            build_epub(title, "", "", all_chapters, output_path)
            # Remove old file if we merged into a new filename
            if existing_chapters and merge_path and merge_path != output_path:
                try:
                    os.remove(merge_path)
                except OSError:
                    pass
            yield json.dumps({
                "type": "done",
                "path": output_path,
                "from_ch": effective_from_ch,
                "to_ch": to_ch,
            }) + "\n"
        except Exception as e:
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"

    return Response(generate(), mimetype="application/x-ndjson")


# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"ReadHive server running at http://localhost:{PORT}")
    print("Open epub.html in your browser, then use it to download novels.")
    print("Press Ctrl-C to stop.\n")
    app.run(host="127.0.0.1", port=PORT, debug=False)
