import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone

NOTION_TOKEN = os.environ.get("NOTION_TOKEN", "")
DATABASE_ID = os.environ.get("NOTION_DATABASE_ID", "")

HEADERS = {
    "Authorization": f"Bearer {NOTION_TOKEN}",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
}

def notion_request(url, method="GET", data=None):
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=HEADERS, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"HTTP Error {e.code}: {e.read().decode()}")
        sys.exit(1)

def get_all_pages():
    pages = []
    start_cursor = None
    while True:
        body = {"page_size": 100}
        if start_cursor:
            body["start_cursor"] = start_cursor
        result = notion_request(
            f"https://api.notion.com/v1/databases/{DATABASE_ID}/query",
            method="POST",
            data=body,
        )
        pages.extend(result.get("results", []))
        if not result.get("has_more"):
            break
        start_cursor = result.get("next_cursor")
    return pages

def extract_text(prop):
    if not prop:
        return ""
    items = prop.get("rich_text") or prop.get("title") or []
    return "".join(item.get("plain_text", "") for item in items)

def extract_multi_select(prop):
    if not prop:
        return []
    return [opt.get("name", "") for opt in prop.get("multi_select", [])]

def extract_number(prop):
    if not prop:
        return None
    return prop.get("number")

def extract_checkbox(prop):
    if not prop:
        return False
    return prop.get("checkbox", False)

def parse_page(page):
    props = page.get("properties", {})
    page_id = page["id"].replace("-", "")
    return {
        "id": page_id,
        "cita": extract_text(props.get("Cita") or props.get("Name") or props.get("Nombre")),
        "autor": extract_text(props.get("Autor")),
        "obra": extract_text(props.get("Obra")),
        "pagina": extract_number(props.get("Pagina") or props.get("Pagina")),
        "categorias": extract_multi_select(props.get("Categoria") or props.get("Categoria")),
        "favorita": extract_checkbox(props.get("Favorita")),
    }

def main():
    if not NOTION_TOKEN or not DATABASE_ID:
        print("Missing NOTION_TOKEN or NOTION_DATABASE_ID")
        sys.exit(1)
    print(f"Fetching from Notion database: {DATABASE_ID[:8]}...")
    pages = get_all_pages()
    print(f"Found {len(pages)} pages")
    quotes = [parse_page(p) for p in pages]
    quotes = [q for q in quotes if q["cita"].strip()]
    print(f"{len(quotes)} valid quotes")
    with open("quotes.json", "w", encoding="utf-8") as f:
        json.dump(quotes, f, ensure_ascii=False, indent=2)
    with open("sync-meta.json", "w", encoding="utf-8") as f:
        json.dump({"synced_at": datetime.now(timezone.utc).isoformat(), "total": len(quotes)}, f)
    print(f"Done")

if __name__ == "__main__":
    main()
