#!/usr/bin/env python3
"""
Sync Notion → quotes.json + books.json + covers/
Runs hourly via GitHub Actions.

Required env vars:
  NOTION_TOKEN              Integration token (secret_...)
  NOTION_DATABASE_ID        Citas database ID
  NOTION_BOOKS_DATABASE_ID  Libros database ID
"""

import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

NOTION_TOKEN = os.environ.get("NOTION_TOKEN", "")
CITAS_DB_ID  = os.environ.get("NOTION_DATABASE_ID", "")
BOOKS_DB_ID  = os.environ.get("NOTION_BOOKS_DATABASE_ID", "")

HEADERS = {
    "Authorization": "Bearer " + NOTION_TOKEN,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
}

COVERS_DIR = Path("covers")


# ── HTTP ────────────────────────────────────────────────

def notion_request(url, method="GET", data=None):
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=HEADERS, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"HTTP Error {e.code}: {e.read().decode()}")
        sys.exit(1)


def download_file(url, dest):
    try:
        with urllib.request.urlopen(url) as resp:
            dest.write_bytes(resp.read())
        return True
    except Exception as e:
        print(f"   Warning: could not download {url}: {e}")
        return False


def get_all_pages(database_id):
    pages, cursor = [], None
    while True:
        body = {"page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        result = notion_request(
            f"https://api.notion.com/v1/databases/{database_id}/query",
            method="POST", data=body,
        )
        pages.extend(result.get("results", []))
        if not result.get("has_more"):
            break
        cursor = result.get("next_cursor")
    return pages


# ── Property extractors ─────────────────────────────────

def text(prop):
    if not prop:
        return ""
    items = prop.get("rich_text") or prop.get("title") or []
    return "".join(i.get("plain_text", "") for i in items).strip()


def select(prop):
    if not prop:
        return ""
    s = prop.get("select")
    return s.get("name", "").strip() if s else ""


def multi_select(prop):
    if not prop:
        return []
    return [o.get("name", "") for o in prop.get("multi_select", [])]


def number(prop):
    return prop.get("number") if prop else None


def checkbox(prop):
    return prop.get("checkbox", False) if prop else False


def date_start(prop):
    if not prop:
        return None
    d = prop.get("date")
    return d.get("start") if d else None


def rating(prop):
    """Extract 1-5 rating from number or select (★ symbols or digit)."""
    if not prop:
        return None
    if "number" in prop:
        return prop["number"]
    s = prop.get("select")
    if s:
        name = s.get("name", "")
        n = name.count("★") or name.count("⭐")
        if n:
            return n
        try:
            return int(name)
        except ValueError:
            pass
    return None


def cover_url(prop):
    """First URL from a Files & Media property."""
    if not prop:
        return None
    files = prop.get("files", [])
    if not files:
        return None
    f = files[0]
    if f.get("type") == "file":
        return f["file"].get("url")
    if f.get("type") == "external":
        return f["external"].get("url")
    return None


# ── Parsers ─────────────────────────────────────────────

def parse_quote(page):
    p = page.get("properties", {})
    return {
        "id":         page["id"].replace("-", ""),
        "cita":       text(p.get("Cita") or p.get("Name") or p.get("Nombre")),
        "autor":      select(p.get("Autor")) or text(p.get("Autor")),
        "obra":       select(p.get("Obra"))  or text(p.get("Obra")),
        "pagina":     number(p.get("Página") or p.get("Pagina")),
        "categorias": multi_select(p.get("Categoría") or p.get("Categoria")),
        "favorita":   checkbox(p.get("Favorita")),
        "valoracion": rating(p.get("Valoración") or p.get("Valoracion") or p.get("Rating")),
    }


def parse_book(page):
    p = page.get("properties", {})
    return {
        "id":            page["id"].replace("-", ""),
        "titulo":        text(p.get("Título") or p.get("Titulo") or p.get("Name") or p.get("Nombre")),
        "autor":         select(p.get("Autor")) or text(p.get("Autor")),
        "estado":        select(p.get("Estado") or p.get("Status")),
        "valoracion":    rating(p.get("Valoración") or p.get("Valoracion") or p.get("Rating")),
        "fecha_lectura": date_start(p.get("Fecha de lectura") or p.get("Fecha") or p.get("Date")),
        "_cover_url":    cover_url(p.get("Portada") or p.get("Cover") or p.get("Imagen")),
    }


# ── Cover download ──────────────────────────────────────

def sync_covers(books):
    COVERS_DIR.mkdir(exist_ok=True)
    for book in books:
        url = book.pop("_cover_url", None)
        if not url:
            book["portada"] = None
            continue
        ext = next((e.lstrip(".") for e in [".png", ".jpg", ".jpeg", ".webp"] if e in url.lower()), "jpg")
        dest = COVERS_DIR / f"{book['id']}.{ext}"
        book["portada"] = str(dest) if download_file(url, dest) else None
        if book["portada"]:
            print(f"   ✓ Cover: {book['titulo']}")


# ── Main ────────────────────────────────────────────────

def main():
    if not NOTION_TOKEN:
        print("❌ Missing NOTION_TOKEN"); sys.exit(1)

    if CITAS_DB_ID:
        print(f"📝 Fetching citas: {CITAS_DB_ID[:8]}...")
        pages  = get_all_pages(CITAS_DB_ID)
        quotes = [parse_quote(p) for p in pages]
        quotes = [q for q in quotes if q["cita"].strip()]
        print(f"   {len(quotes)} citas válidas")
        with open("quotes.json", "w", encoding="utf-8") as f:
            json.dump(quotes, f, ensure_ascii=False, indent=2)
        print("✅ quotes.json written")
    else:
        print("⚠️  NOTION_DATABASE_ID not set — skipping")

    if BOOKS_DB_ID:
        print(f"📚 Fetching libros: {BOOKS_DB_ID[:8]}...")
        pages = get_all_pages(BOOKS_DB_ID)
        books = [parse_book(p) for p in pages]
        books = [b for b in books if b["titulo"].strip()]
        print(f"   {len(books)} libros")
        sync_covers(books)
        with open("books.json", "w", encoding="utf-8") as f:
            json.dump(books, f, ensure_ascii=False, indent=2)
        print("✅ books.json written")
    else:
        print("⚠️  NOTION_BOOKS_DATABASE_ID not set — skipping")

    with open("sync-meta.json", "w", encoding="utf-8") as f:
        json.dump({"synced_at": datetime.now(timezone.utc).isoformat()}, f)


if __name__ == "__main__":
    main()
