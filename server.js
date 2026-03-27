import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3000

const NOTION_TOKEN   = process.env.NOTION_TOKEN
const QUOTES_DB      = process.env.NOTION_QUOTES_DB  || 'e79059209139461fb2c17d39bf0fe687'
const BOOKS_DB       = process.env.NOTION_BOOKS_DB   || '2b21bd2a8d4f80a5ba96f19f6ad4dac7'
const CACHE_TTL      = 15 * 60 * 1000 // 15 min — Notion file URLs expire in ~1h

let cache = { data: null, at: 0 }

app.use(express.json())
app.use(express.static(join(__dirname, 'public')))

// ── Notion helpers ─────────────────────────────────────────────────────────

async function notionQuery(dbId, filter = null) {
  const pages = []
  let cursor

  while (true) {
    const body = { page_size: 100 }
    if (cursor) body.start_cursor = cursor
    if (filter)  body.filter = filter

    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Notion query error ${res.status}: ${err}`)
    }

    const data = await res.json()
    pages.push(...data.results)
    if (!data.has_more) break
    cursor = data.next_cursor
  }

  return pages
}

function fileUrl(prop) {
  if (!prop?.files?.length) return null
  const f = prop.files[0]
  return f.type === 'file' ? f.file?.url : f.external?.url ?? null
}

function richText(prop) {
  const items = prop?.rich_text ?? prop?.title ?? []
  return items.map(i => i.plain_text).join('')
}

function relationIds(prop) {
  return (prop?.relation ?? []).map(r => r.id)
}

// ── Build library ──────────────────────────────────────────────────────────

async function buildLibrary() {
  const [bookPages, quotePagesRaw] = await Promise.all([
    notionQuery(BOOKS_DB),
    notionQuery(QUOTES_DB),
  ])

  // Process books
  const books = bookPages
    .map(p => ({
      id:       p.id,
      nombre:   richText(p.properties.Nombre),
      author:   richText(p.properties.Author),
      rating:   p.properties['My Rating']?.number ?? null,
      portada:  fileUrl(p.properties.Portada),
      shelf:    p.properties['Exclusive Shelf']?.select?.name ?? null,
      dateRead: p.properties['Date Read']?.date?.start ?? null,
      quotes:   [],
    }))
    .filter(b => b.nombre.trim())

  const bookMap = new Map(books.map(b => [b.id, b]))

  // Process quotes
  const allQuotes = quotePagesRaw
    .map(p => {
      const cita = richText(p.properties.Cita)
      if (!cita.trim()) return null
      return {
        id:         p.id,
        cita,
        autor:      richText(p.properties.Autor),
        obra:       richText(p.properties.Obra),
        pagina:     p.properties['Página']?.number ?? null,
        categorias: p.properties['Categoría']?.multi_select?.map(s => s.name) ?? [],
        favorita:   p.properties.Favorita?.checkbox ?? false,
        bookIds:    relationIds(p.properties.Libro),
      }
    })
    .filter(Boolean)

  // Attach quotes to their books
  for (const q of allQuotes) {
    for (const bid of q.bookIds) {
      bookMap.get(bid)?.quotes.push(q)
    }
  }

  // Library = books with at least one quote, sorted by date read desc
  const library = books
    .filter(b => b.quotes.length > 0)
    .sort((a, b) => {
      if (a.dateRead && b.dateRead) return b.dateRead.localeCompare(a.dateRead)
      if (a.dateRead) return -1
      if (b.dateRead) return  1
      return 0
    })

  return { library, allQuotes }
}

async function getData() {
  if (cache.data && Date.now() - cache.at < CACHE_TTL) return cache.data
  const data = await buildLibrary()
  cache = { data, at: Date.now() }
  return data
}

// ── API routes ─────────────────────────────────────────────────────────────

// Full library (books + their quotes)
app.get('/api/library', async (req, res) => {
  try {
    const { library } = await getData()
    res.json(library)
  } catch (err) {
    console.error('GET /api/library', err.message)
    res.status(500).json({ error: err.message })
  }
})

// 3 random quotes with their book cover attached
app.get('/api/random', async (req, res) => {
  try {
    const { allQuotes, library } = await getData()
    if (!allQuotes.length) return res.json([])

    const bookById = new Map(library.map(b => [b.id, b]))
    const shuffled = [...allQuotes].sort(() => Math.random() - 0.5)
    const three = shuffled.slice(0, 3).map(q => {
      const book = q.bookIds.map(id => bookById.get(id)).find(Boolean)
      return { ...q, bookPortada: book?.portada ?? null, bookNombre: book?.nombre ?? q.obra }
    })

    res.json(three)
  } catch (err) {
    console.error('GET /api/random', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Toggle favorite → writes back to Notion
app.patch('/api/quotes/:id/favorite', async (req, res) => {
  const { id } = req.params
  const { favorita } = req.body

  if (typeof favorita !== 'boolean') {
    return res.status(400).json({ error: '`favorita` must be boolean' })
  }

  try {
    const notionRes = await fetch(`https://api.notion.com/v1/pages/${id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties: { Favorita: { checkbox: favorita } } }),
    })

    if (!notionRes.ok) {
      const err = await notionRes.text()
      throw new Error(`Notion PATCH error ${notionRes.status}: ${err}`)
    }

    // Update in-memory cache immediately so UI stays consistent
    if (cache.data) {
      for (const q of cache.data.allQuotes) {
        if (q.id === id) { q.favorita = favorita; break }
      }
      for (const b of cache.data.library) {
        const q = b.quotes.find(q => q.id === id)
        if (q) { q.favorita = favorita; break }
      }
    }

    res.json({ ok: true, favorita })
  } catch (err) {
    console.error('PATCH /api/quotes/:id/favorite', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Force cache refresh
app.post('/api/refresh', async (req, res) => {
  cache = { data: null, at: 0 }
  try {
    await getData()
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// SPA fallback
app.get('*', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')))

app.listen(PORT, () => console.log(`📚 Biblioteca en http://localhost:${PORT}`))
