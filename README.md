# 📚 Mis Citas

App web para explorar tu base de datos de citas literarias, sincronizada automáticamente desde Notion.

**[Ver demo →](https://TU-USUARIO.github.io/citas-app)**

---

## ✨ Funciones

- 📖 Cita aleatoria con navegación
- 🔍 Filtros por autor, obra y categoría
- ♥ Marcar favoritas (guardadas en el navegador)
- 𝕏 Compartir directamente en X (Twitter)
- 🔄 Sincronización automática desde Notion cada hora

---

## 🚀 Setup en 5 pasos

### 1. Fork / clonar este repo en tu GitHub

### 2. Crear integración de Notion

1. Ve a [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Crea una integración nueva → copia el **Internal Integration Token** (`secret_...`)
3. En tu base de datos de Notion → **"..." → Connections → Añadir tu integración**

### 3. Obtener el Database ID

La URL de tu base de datos tiene esta forma:
```
https://www.notion.so/TU-WORKSPACE/XXXXXXXXXXXXXXXX?v=...
```
El `XXXXXXXXXXXXXXXX` (32 caracteres) es tu **Database ID**.

### 4. Añadir secrets en GitHub

Ve a tu repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Valor |
|--------|-------|
| `NOTION_TOKEN` | `secret_xxxxx...` |
| `NOTION_DATABASE_ID` | `xxxxxxxxxxxxxxxx...` |

### 5. Activar GitHub Pages

Ve a **Settings → Pages → Source → GitHub Actions** (o rama `main`, carpeta `/`).

---

## 🗄️ Estructura esperada en Notion

| Campo | Tipo | Notas |
|-------|------|-------|
| **Cita** | Título | Texto de la cita |
| **Autor** | Select | Nombre del autor |
| **Obra** | Select | Título del libro |
| **Página** | Number | Número de página |
| **Categoría** | Multi-select | Amor, Vida, Literatura... |
| **Favorita** | Checkbox | Marcadas como favoritas |

---

## 🔄 Sincronización manual

En GitHub → **Actions → Sync Notion → Run workflow** para sincronizar en cualquier momento sin esperar a la hora.

---

## 🛠️ Desarrollo local

```bash
# Servir localmente (necesitas un servidor HTTP, no file://)
python -m http.server 8000

# Sincronizar manualmente (con variables de entorno)
export NOTION_TOKEN="secret_..."
export NOTION_DATABASE_ID="..."
python sync-notion.py
```
