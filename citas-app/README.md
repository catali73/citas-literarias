# 📚 Citas Literarias

App personal para explorar y compartir citas literarias sincronizadas desde Notion.

**Demo:** https://TU-USUARIO.github.io/citas-literarias

## Funciones

- 🎲 Cita aleatoria al abrir
- 🔍 Filtros por autor, obra y categoría
- ♥ Guardar favoritas (persistente en el navegador)
- 🐦 Compartir directamente en X (Twitter)
- 🔄 Sincronización automática con Notion cada hora

## Configuración (una sola vez)

### 1. Crear repositorio en GitHub

```bash
git init
git remote add origin https://github.com/TU-USUARIO/citas-literarias.git
git add .
git commit -m "init"
git push -u origin main
```

### 2. Añadir secretos en GitHub

Ve a tu repo → **Settings → Secrets and variables → Actions → New secret**

| Nombre | Valor |
|--------|-------|
| `NOTION_TOKEN` | Tu token de integración de Notion |
| `NOTION_DATABASE_ID` | `e7905920-9139-461f-b2c1-7d39bf0fe687` |

**Obtener el token:** https://www.notion.so/my-integrations → Nueva integración → copiar el "Internal Integration Token"

**Importante:** Asegúrate de que la integración tiene acceso a tu base de datos en Notion (Settings → Connections).

### 3. Activar GitHub Pages

Ve a **Settings → Pages → Source: GitHub Actions** (o "Deploy from branch: main, /root").

### 4. Ejecutar el primer sync

Ve a **Actions → Sync Quotes from Notion → Run workflow**

¡Listo! La app se publicará en `https://TU-USUARIO.github.io/citas-literarias`

---

## Estructura

```
├── index.html          ← La app completa
├── quotes.json         ← Datos (generado automáticamente)
├── sync_notion.py      ← Script de sincronización
└── .github/workflows/
    └── sync-notion.yml ← GitHub Action (se ejecuta cada hora)
```
