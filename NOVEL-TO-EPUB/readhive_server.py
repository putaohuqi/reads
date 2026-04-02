#!/usr/bin/env python3
"""
ReadHive → EPUB local server
Runs on http://localhost:7842 and is used by epub.html.

Start with:  python3 NOVEL-TO-EPUB/readhive_server.py
Stop with:   Ctrl-C
"""

import json
import mimetypes
import os
import re
import threading
import time
import uuid
from html import escape
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from ebooklib import epub
from flask import Flask, Response, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

PORT = 7842
BASE_URL = "https://readhive.org"
CANCEL_EVENTS: dict[str, threading.Event] = {}
CANCEL_EVENTS_LOCK = threading.Lock()

# ─── Scraping helpers ─────────────────────────────────────────────────────────

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}

WORDPRESS_CATEGORY_SEGMENT = "/category/"
WORDPRESS_CHAPTER_RE = re.compile(r"\bchapter\W*(\d+)\b", re.I)


def detect_source(url: str) -> str:
    host = urlparse(url).netloc.lower()
    if host.startswith("www."):
        host = host[4:]

    if host.endswith("readhive.org"):
        return "readhive"
    if host.endswith("webnovel.com"):
        return "webnovel"
    if host.endswith("novelupdates.com"):
        return "novelupdates"
    if host.endswith("wordpress.com"):
        return "wordpress"
    return "other"


def unsupported_source_message(source: str) -> str:
    if source == "webnovel":
        return (
            "Webnovel can be used for discovery, but this downloader cannot "
            "generate EPUBs from Webnovel directly yet. Open the Webnovel search "
            "result, then paste a supported translator-site URL here."
        )
    if source == "novelupdates":
        return (
            "Novel Updates is a directory, not a direct chapter source. Use it to "
            "find translator sites, then paste the translator URL here."
        )
    return "cannot generate epub for this site yet"


def register_cancel_event(job_id: str) -> threading.Event:
    event = threading.Event()
    with CANCEL_EVENTS_LOCK:
        CANCEL_EVENTS[job_id] = event
    return event


def get_cancel_event(job_id: str) -> threading.Event | None:
    with CANCEL_EVENTS_LOCK:
        return CANCEL_EVENTS.get(job_id)


def clear_cancel_event(job_id: str) -> None:
    with CANCEL_EVENTS_LOCK:
        CANCEL_EVENTS.pop(job_id, None)


def absolute_url(url: str) -> str:
    return urljoin(BASE_URL, url)


def absolute_url_for(base_url: str, url: str) -> str:
    return urljoin(base_url, url)


def fetch_soup(url: str, timeout: int = 20) -> BeautifulSoup:
    response = requests.get(url, headers=HEADERS, timeout=timeout)
    response.raise_for_status()
    return BeautifulSoup(response.text, "html.parser")


def get_meta_content(soup: BeautifulSoup, *, prop: str = "", name: str = "") -> str:
    if prop:
        meta = soup.find("meta", attrs={"property": prop})
        if meta and meta.get("content"):
            return meta["content"].strip()
    if name:
        meta = soup.find("meta", attrs={"name": name})
        if meta and meta.get("content"):
            return meta["content"].strip()
    return ""


def clean_text_html(value: str) -> str:
    return BeautifulSoup(value or "", "html.parser").get_text(" ", strip=True)


def extract_wordpress_author(description: str, site_title: str) -> str:
    text = clean_text_html(description)
    author_match = re.search(r"\bI['’]m\s+([A-Za-z0-9 _-]{2,40}?)(?:\s+(?:and|&)\b|[,.!~]|$)", text, re.I)
    if author_match:
        return author_match.group(1).strip()
    return site_title


def extract_wordpress_chapter_number(title: str) -> int | None:
    match = WORDPRESS_CHAPTER_RE.search(title or "")
    if not match:
        return None
    try:
        return int(match.group(1))
    except ValueError:
        return None


def infer_wordpress_series_title(page_title: str) -> str:
    text = clean_text_html(page_title)
    if not text:
        return ""
    split = re.split(r"\s*:\s*Chapter\b", text, maxsplit=1, flags=re.I)
    if split and split[0].strip():
        return split[0].strip()
    return text


def normalize_wordpress_category_url(url: str) -> str:
    parsed = urlparse(url)
    path = re.sub(r"/page/\d+/?$", "/", parsed.path or "/")
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def extract_wordpress_category_url(page_url: str, soup: BeautifulSoup) -> str:
    parsed = urlparse(page_url)
    if WORDPRESS_CATEGORY_SEGMENT in parsed.path:
        return normalize_wordpress_category_url(page_url)

    selectors = [
        ".wp-block-post-terms a[href*='/category/']",
        ".wp-block-categories a[href*='/category/']",
        "a[href*='/category/']",
    ]
    seen: list[str] = []
    for selector in selectors:
        for link in soup.select(selector):
            href = link.get("href", "").strip()
            if not href:
                continue
            resolved = absolute_url_for(page_url, href)
            normalized = normalize_wordpress_category_url(resolved)
            if normalized not in seen:
                seen.append(normalized)

    if len(seen) == 1:
        return seen[0]

    for candidate in seen:
        if "uncategorized" not in candidate.lower():
            return candidate
    return seen[0] if seen else ""


def fetch_wordpress_page(url: str) -> tuple[BeautifulSoup, str, str, str, str]:
    soup = fetch_soup(url)
    site_title = (
        get_meta_content(soup, prop="og:site_name")
        or clean_text_html(get_meta_content(soup, prop="og:title"))
        or clean_text_html(soup.title.get_text(" ", strip=True) if soup.title else "")
    )
    description = (
        get_meta_content(soup, prop="og:description")
        or get_meta_content(soup, name="description")
    )
    cover_url = get_meta_content(soup, prop="og:image")
    category_url = extract_wordpress_category_url(url, soup)
    return soup, site_title, description, cover_url, category_url


def collect_wordpress_chapters(category_url: str, expected_title: str = "") -> dict[int, str]:
    chapters: dict[int, str] = {}
    next_url = category_url
    visited: set[str] = set()

    for _ in range(60):
        if not next_url or next_url in visited:
            break
        visited.add(next_url)
        soup = fetch_soup(next_url)

        for link in soup.select(".wp-block-post-title a[href], .wp-block-latest-posts__post-title[href]"):
            href = link.get("href", "").strip()
            title = clean_text_html(link.get_text(" ", strip=True))
            chapter_num = extract_wordpress_chapter_number(title)
            if not href or chapter_num is None:
                continue
            if expected_title:
                normalized_title = title.casefold()
                if expected_title.casefold() not in normalized_title:
                    continue
            chapters.setdefault(chapter_num, absolute_url_for(next_url, href))

        next_link = soup.select_one(".wp-block-query-pagination-next[href]")
        next_url = absolute_url_for(next_url, next_link["href"]) if next_link and next_link.get("href") else ""

    return chapters


def fetch_wordpress_series_info(url: str) -> tuple[str, str, str, int, str, int, int, str]:
    soup, site_title, description, cover_url, category_url = fetch_wordpress_page(url)
    if not category_url:
        raise ValueError(
            "could not determine the novel archive for this translator site. "
            "try pasting the category url directly."
        )

    category_soup = fetch_soup(category_url)
    category_description = (
        get_meta_content(category_soup, prop="og:description")
        or get_meta_content(category_soup, name="description")
    )
    category_cover_url = get_meta_content(category_soup, prop="og:image")
    if category_description.lower().startswith("posts about "):
        category_description = ""

    parsed_category = urlparse(category_url)
    site_root = f"{parsed_category.scheme}://{parsed_category.netloc}/"
    parsed_input = urlparse(url)
    input_path = parsed_input.path.rstrip("/")
    is_site_root_input = input_path in {"", "/"}
    is_category_input = normalize_wordpress_category_url(url) == category_url

    if (
        (not is_site_root_input and not is_category_input)
        or not description
        or description.lower().startswith("posts about ")
        or len(clean_text_html(description)) > 180
        or "chapter" in clean_text_html(description).lower()
    ):
        _, root_site_title, root_description, root_cover_url, _ = fetch_wordpress_page(site_root)
        if root_site_title:
            site_title = root_site_title
        if root_description:
            description = root_description
        if root_cover_url:
            cover_url = root_cover_url
    elif category_description and normalize_wordpress_category_url(url) != category_url:
        description = category_description
    if category_cover_url:
        cover_url = category_cover_url

    category_heading = (
        category_soup.select_one(".wp-block-query-title span")
        or category_soup.select_one(".wp-block-query-title")
    )
    series_title = clean_text_html(category_heading.get_text(" ", strip=True) if category_heading else "")
    series_title = re.sub(r"^\s*Category:\s*", "", series_title, flags=re.I).strip()
    if not series_title:
        page_og_title = get_meta_content(soup, prop="og:title")
        series_title = infer_wordpress_series_title(page_og_title or site_title)
    if not series_title:
        series_title = site_title or "WordPress translator series"

    chapters = collect_wordpress_chapters(category_url, series_title)
    if not chapters:
        raise ValueError("could not find chapter posts for this translator site")

    chapter_numbers = sorted(chapters)
    total_chapters = chapter_numbers[-1]
    first_chapter = chapter_numbers[0]
    author = extract_wordpress_author(description, site_title or series_title)
    resolved_cover_url = absolute_url_for(url, cover_url) if cover_url else ""

    return (
        series_title,
        author,
        clean_text_html(description),
        total_chapters,
        resolved_cover_url,
        first_chapter,
        len(chapter_numbers),
        category_url,
    )


def parse_series_url(url: str) -> str | None:
    m = re.search(r"readhive\.org/series/(\d+)", url)
    return m.group(1) if m else None


def search_readhive(query: str) -> list[dict[str, str]]:
    response = requests.post(
        absolute_url("/ajax"),
        headers=HEADERS,
        data={"action": "search", "query": query},
        timeout=20,
    )
    response.raise_for_status()
    payload = response.json()
    items = payload.get("data", []) if isinstance(payload, dict) else []
    results: list[dict[str, str]] = []

    for item in items[:6]:
        title = str(item.get("title", "")).strip()
        url = str(item.get("url", "")).strip()
        thumb = str(item.get("thumb", "")).strip()
        series_id = parse_series_url(url)
        if not title or not url or not series_id:
            continue
        results.append(
            {
                "series_id": series_id,
                "title": title,
                "url": url,
                "thumb": absolute_url(thumb) if thumb else "",
                "source": "readhive",
            }
        )

    return results


def fetch_series_info(series_id: str) -> tuple[str, str, str, int, str]:
    url = absolute_url(f"/series/{series_id}/")
    r = requests.get(url, headers=HEADERS, timeout=15)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    title = (soup.find("h1") or soup.find("h2") or soup.new_tag("x")).get_text(strip=True)

    author = ""
    author_el = soup.select_one("section h1 + span")
    if author_el:
        author = author_el.get_text(" ", strip=True)
    if not author:
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
    if not desc:
        meta_desc = soup.find("meta", attrs={"property": "og:description"}) or soup.find("meta", attrs={"name": "description"})
        if meta_desc and meta_desc.get("content"):
            desc = BeautifulSoup(meta_desc["content"], "html.parser").get_text(" ", strip=True)

    cover_url = ""
    cover_meta = soup.find("meta", attrs={"property": "og:image"}) or soup.find("meta", attrs={"name": "og:image"})
    if cover_meta and cover_meta.get("content"):
        cover_url = absolute_url(cover_meta["content"].strip())
    if not cover_url:
        cover_img = soup.select_one("img[alt*='Cover']") or soup.select_one("img[src]")
        if cover_img and cover_img.get("src"):
            cover_url = absolute_url(cover_img["src"].strip())

    chapter_links = set()
    for a in soup.find_all("a", href=True):
        m = re.search(rf"/series/{series_id}/(\d+)/?$", a["href"])
        if m:
            chapter_links.add(int(m.group(1)))

    total = max(chapter_links) if chapter_links else 0
    return title, author, desc, total, cover_url


def sanitize_chapter_html(content_el: BeautifulSoup) -> str:
    removable_tags = {
        "script", "style", "nav", "button", "form", "svg", "path",
        "aside", "header", "footer", "input", "template", "noscript",
    }

    for el in [content_el, *list(content_el.find_all(True))]:
        if el is None or getattr(el, "attrs", None) is None:
            continue
        classes = set(el.get("class", []))
        if el.name in removable_tags:
            el.decompose()
            continue
        if el.get("data-fuse") or "code-block" in classes or any(cls.startswith("code-block-") for cls in classes):
            el.decompose()
            continue
        text = el.get_text(" ", strip=True)
        if (
            text.startswith("Author:")
            and len(text) < 120
            and el.name in {"div", "p", "span"}
            and not el.find("p")
            and not el.find("img")
        ):
            el.decompose()
            continue

        allowed_attrs: set[str] = set()
        if el.name == "a":
            allowed_attrs = {"href", "title"}
        elif el.name == "img":
            allowed_attrs = {"src", "alt"}

        for attr in list(el.attrs):
            if attr not in allowed_attrs:
                del el.attrs[attr]

        if el.name == "a" and el.get("href"):
            el["href"] = absolute_url(el["href"])
        if el.name == "img" and el.get("src"):
            el["src"] = absolute_url(el["src"])

    empty_run = 0
    for el in list(content_el.find_all(["p", "div", "span"])):
        text = el.get_text(" ", strip=True).replace("\xa0", "").strip()
        if el.name == "p" and not el.find("img") and not text:
            empty_run += 1
            if empty_run > 1:
                el.decompose()
            continue
        empty_run = 0

    for el in list(content_el.find_all(["div", "span"])):
        if el.find("img"):
            continue
        if not el.get_text(" ", strip=True):
            el.decompose()

    return str(content_el)


def fetch_chapter(series_id: str, chapter_num: int) -> tuple[str, str]:
    url = absolute_url(f"/series/{series_id}/{chapter_num}/")
    soup = fetch_soup(url, timeout=15)

    page_title = soup.title.string if soup.title else f"Chapter {chapter_num}"
    chapter_title = re.sub(r"\s*[–—-]\s*Readhive.*$", "", page_title).strip()
    if not chapter_title:
        chapter_title = f"Chapter {chapter_num}"

    content_el = (
        soup.select_one(".prose > div[style]")
        or soup.select_one(".prose > div")
        or soup.select_one(".prose")
        or soup.find("main")
    )
    if content_el:
        html = sanitize_chapter_html(content_el)
    else:
        html = "<p>Content not found.</p>"

    return chapter_title, html


def fetch_wordpress_chapter(chapter_url: str) -> tuple[str, str]:
    soup = fetch_soup(chapter_url, timeout=20)
    page_title = clean_text_html(get_meta_content(soup, prop="og:title"))
    chapter_title = page_title or clean_text_html(soup.title.get_text(" ", strip=True) if soup.title else "")
    if not chapter_title:
        chapter_title = "Chapter"

    content_el = (
        soup.select_one(".entry-content.wp-block-post-content")
        or soup.select_one(".entry-content")
        or soup.select_one(".wp-block-post-content")
        or soup.find("article")
        or soup.find("main")
    )
    if content_el:
        html = sanitize_chapter_html(content_el)
    else:
        html = "<p>Content not found.</p>"

    return chapter_title, html

# ─── EPUB helpers ─────────────────────────────────────────────────────────────

def get_epub_metadata_value(book: epub.EpubBook, namespace: str, name: str) -> str:
    values = book.get_metadata(namespace, name)
    if not values:
        return ""
    first = values[0]
    if isinstance(first, tuple):
        return str(first[0] or "")
    return str(first or "")


def read_epub_data(epub_path: str) -> tuple[list[tuple[str, str]], str, str]:
    """Extract chapters plus existing author/description metadata from an epub."""
    book = epub.read_epub(epub_path)
    author = get_epub_metadata_value(book, "DC", "creator")
    description = get_epub_metadata_value(book, "DC", "description")
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
    return chapters, author, description


def fetch_cover_image(cover_url: str) -> tuple[str, bytes] | tuple[None, None]:
    if not cover_url:
        return None, None

    resolved_url = absolute_url(cover_url)
    response = requests.get(resolved_url, headers=HEADERS, timeout=20)
    response.raise_for_status()

    content_type = response.headers.get("Content-Type", "").split(";")[0].strip()
    suffix = Path(urlparse(resolved_url).path).suffix.lower()
    if not suffix:
        suffix = mimetypes.guess_extension(content_type) or ".jpg"
    if suffix == ".jpe":
        suffix = ".jpg"

    return f"cover{suffix}", response.content


def build_epub(title: str, author: str, description: str, cover_url: str,
               chapters: list[tuple[str, str]], output_path: str) -> None:
    book = epub.EpubBook()
    cover_file_name = ""
    book.set_identifier(str(uuid.uuid4()))
    book.set_title(title)
    book.set_language("en")
    if author:
        book.add_author(author)
    if description:
        book.add_metadata("DC", "description", description)
    if cover_url:
        try:
            cover_name, cover_bytes = fetch_cover_image(cover_url)
            if cover_name and cover_bytes:
                cover_file_name = cover_name
                book.set_cover(cover_name, cover_bytes)
        except Exception:
            pass

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

    if description or author or cover_file_name:
        intro = epub.EpubHtml(title="About", file_name="intro.xhtml", lang="en")
        author_html = f"<p><strong>Author:</strong> {escape(author)}</p>" if author else ""
        cover_html = ""
        if cover_file_name:
            cover_html = f'<p><img src="{escape(cover_file_name)}" alt="{escape(title)} cover" /></p>'
        description_html = f"<p>{escape(description)}</p>" if description else ""
        intro.content = f"<h1>{escape(title)}</h1>{author_html}{cover_html}{description_html}"
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
        ch.content = f"<h2>{escape(ch_title)}</h2>{ch_html}"
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
    source = detect_source(url)
    try:
        if source == "readhive":
            series_id = parse_series_url(url)
            if not series_id:
                return "could not find a readhive series ID in this url", 400
            title, author, desc, total, cover_url = fetch_series_info(series_id)
            return {
                "source": source,
                "series_id": series_id,
                "series_url": url,
                "title": title,
                "author": author,
                "description": desc,
                "total_chapters": total,
                "chapter_count": total,
                "min_chapter": 1 if total else 0,
                "cover_url": cover_url,
            }

        if source == "wordpress":
            title, author, desc, total, cover_url, first_chapter, chapter_count, archive_url = fetch_wordpress_series_info(url)
            return {
                "source": source,
                "series_id": archive_url,
                "series_url": archive_url,
                "title": title,
                "author": author,
                "description": desc,
                "total_chapters": total,
                "chapter_count": chapter_count,
                "min_chapter": first_chapter,
                "cover_url": cover_url,
            }
    except Exception as e:
        return str(e), 502

    return unsupported_source_message(source), 400


@app.post("/search-title")
def route_search_title():
    data = request.get_json(force=True) or {}
    query = str(data.get("query", "")).strip()
    if len(query) < 2:
        return "search query must be at least 2 characters", 400

    try:
        readhive_matches = search_readhive(query)
    except Exception as e:
        return str(e), 502

    return {
        "query": query,
        "readhive_matches": readhive_matches,
        "has_readhive_matches": bool(readhive_matches),
    }


@app.get("/cover-preview")
def route_cover_preview():
    raw_url = request.args.get("url", "").strip()
    if not raw_url:
        return "missing url", 400

    resolved_url = absolute_url(raw_url)
    try:
        response = requests.get(resolved_url, headers=HEADERS, timeout=20)
        response.raise_for_status()
    except Exception as e:
        return str(e), 502

    content_type = response.headers.get("Content-Type", "").split(";")[0].strip()
    if not content_type:
        guessed_type, _ = mimetypes.guess_type(resolved_url)
        content_type = guessed_type or "image/jpeg"

    if not content_type.startswith("image/"):
        return "cover preview is not an image", 415

    preview = Response(response.content, mimetype=content_type)
    preview.headers["Cache-Control"] = "public, max-age=3600"
    return preview

@app.post("/download")
def route_download():
    data = request.get_json(force=True) or {}
    series_id = data.get("series_id", "").strip()
    source = str(data.get("source", "")).strip() or ("readhive" if series_id.isdigit() else "")
    series_url = str(data.get("url", "")).strip()
    job_id = str(data.get("job_id", "")).strip() or str(uuid.uuid4())
    from_ch = int(data.get("from_ch", 1))
    to_ch = int(data.get("to_ch", 1))
    delay = float(data.get("delay", 1.0))
    title = data.get("title", f"series_{series_id}")
    author = str(data.get("author", "")).strip()
    description = str(data.get("description", "")).strip()
    cover_url = str(data.get("cover_url", "")).strip()
    merge_path = data.get("merge_path", "").strip()
    original_from_ch = int(data.get("original_from_ch", from_ch))

    if source == "readhive" and not series_id:
        return "missing series_id", 400
    if source == "wordpress" and not series_url:
        series_url = series_id
    if source == "wordpress" and not series_url:
        return "missing url for wordpress source", 400
    if source not in {"readhive", "wordpress"}:
        return unsupported_source_message(source or detect_source(series_url or series_id)), 400

    cancel_event = register_cancel_event(job_id)

    def generate():
        try:
            def is_cancelled() -> bool:
                return cancel_event.is_set()

            def cancelled_payload() -> str:
                return json.dumps({
                    "type": "cancelled",
                    "message": "download cancelled",
                    "job_id": job_id,
                }) + "\n"

            # ── load existing epub if merging ──
            existing_chapters = []
            effective_from_ch = from_ch  # what to report back as the epub's start
            effective_author = author
            effective_description = description
            effective_cover_url = cover_url
            wordpress_archive_url = series_url
            wordpress_chapter_map: dict[int, str] = {}

            if not (effective_author and effective_description and effective_cover_url):
                try:
                    if source == "readhive":
                        _, fetched_author, fetched_description, _, fetched_cover_url = fetch_series_info(series_id)
                    else:
                        (
                            _,
                            fetched_author,
                            fetched_description,
                            _,
                            fetched_cover_url,
                            _,
                            _,
                            fetched_archive_url,
                        ) = fetch_wordpress_series_info(series_url)
                        if fetched_archive_url:
                            wordpress_archive_url = fetched_archive_url
                    if not effective_author:
                        effective_author = fetched_author
                    if not effective_description:
                        effective_description = fetched_description
                    if not effective_cover_url:
                        effective_cover_url = fetched_cover_url
                except Exception:
                    pass

            if source == "wordpress":
                try:
                    wordpress_chapter_map = collect_wordpress_chapters(wordpress_archive_url)
                except Exception as e:
                    yield json.dumps({
                        "type": "error",
                        "message": f"could not load wordpress chapter list: {e}",
                    }) + "\n"
                    return

            if merge_path and os.path.isfile(merge_path):
                try:
                    existing_chapters, existing_author, existing_description = read_epub_data(merge_path)
                    if not effective_author:
                        effective_author = existing_author
                    if not effective_description:
                        effective_description = existing_description
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
                if is_cancelled():
                    yield cancelled_payload()
                    return

                try:
                    if source == "readhive":
                        ch_title, ch_html = fetch_chapter(series_id, ch_num)
                    else:
                        chapter_url = wordpress_chapter_map.get(ch_num)
                        if not chapter_url:
                            raise ValueError("chapter url not found")
                        ch_title, ch_html = fetch_wordpress_chapter(chapter_url)
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
                    slept = 0.0
                    while slept < delay:
                        if is_cancelled():
                            yield cancelled_payload()
                            return
                        pause = min(0.1, delay - slept)
                        time.sleep(pause)
                        slept += pause

            if is_cancelled():
                yield cancelled_payload()
                return

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
                build_epub(title, effective_author, effective_description, effective_cover_url, all_chapters, output_path)
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
        finally:
            clear_cancel_event(job_id)

    return Response(generate(), mimetype="application/x-ndjson")


@app.post("/cancel")
def route_cancel():
    data = request.get_json(force=True) or {}
    job_id = str(data.get("job_id", "")).strip()
    if not job_id:
        return {"ok": False, "message": "missing job_id"}, 400

    cancel_event = get_cancel_event(job_id)
    if not cancel_event:
        return {"ok": False, "message": "download not found"}, 404

    cancel_event.set()
    return {"ok": True}


# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"ReadHive server running at http://localhost:{PORT}")
    print("Open epub.html in your browser, then use it to download novels.")
    print("Press Ctrl-C to stop.\n")
    app.run(host="127.0.0.1", port=PORT, debug=False)
