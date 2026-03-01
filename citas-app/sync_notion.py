"""
Script para sincronizar citas de Notion a quotes.json
Ejecutado por GitHub Actions cada hora.
"""

import os
import json
import requests

TOKEN = os.environ["NOTION_TOKEN"]
DATABASE_ID = os.environ["NOTION_DATABASE_ID"]

HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
}

def fetch_all_pages():
    url = f"https://api.notion.com/v1/databases/{DATABASE_ID}/query"
    results = []
    payload = {"page_size": 100}

    while True:
        r = requests.post(url, headers=HEADERS, json=payload)
        r.raise_for_status()
        data = r.json()
        results.extend(data["results"])
        if not data.get("has_more"):
            break
        payload["start_cursor"] = data["next_cursor"]

    return results


def parse_page(page):
    props = page["properties"]

    def text(prop):
        items = props.get(prop, {}).get("title") or props.get(prop, {}).get("rich_text") or []
        return "".join(t["plain_text"] for t in items).strip()

    def select(prop):
        val = props.get(prop, {}).get("select")
        return val["name"] if val else ""

    def multi_select(prop):
        items = props.get(prop, {}).get("multi_select", [])
        return [i["name"] for i in items]

    def checkbox(prop):
        return props.get(prop, {}).get("checkbox", False)

    def number(prop):
        return props.get(prop, {}).get("number")

    return {
        "id": page["id"],
        "cita": text("Cita") or text("Name"),   # título de la DB
        "autor": select("Autor"),
        "obra": select("Obra"),
        "categorias": multi_select("Categoría"),
        "favorita": checkbox("Favorita"),
        "pagina": number("Página"),
    }


def main():
    print("Fetching from Notion...")
    pages = fetch_all_pages()
    quotes = [parse_page(p) for p in pages]
    # Filtrar entradas vacías
    quotes = [q for q in quotes if q["cita"]]
    quotes.sort(key=lambda q: q["autor"])

    with open("quotes.json", "w", encoding="utf-8") as f:
        json.dump(quotes, f, ensure_ascii=False, indent=2)

    print(f"✓ Saved {len(quotes)} quotes to quotes.json")


if __name__ == "__main__":
    main()
