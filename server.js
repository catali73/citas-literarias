import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { pool, initDB, getLibrary, getRandomQuotes } from './db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app  = express()
const PORT = process.env.PORT || 3000

// ── Config ────────────────────────────────────────────────────────────────
const NOTION_TOKEN = process.env.NOTION_TOKEN
const QUOTES_DB    = process.env.NOTION_QUOTES_DB || 'e79059209139461fb2c17d39bf0fe687'
const BOOKS_DB     = process.env.NOTION_BOOKS_DB  || '2b21bd2a8d4f80a5ba96f19f6ad4dac7'
const JWT_SECRET   = process.env.JWT_SECRET || 'noray-secret-change-me'
const ADMIN_HASH   = process.env.ADMIN_PASSWORD_HASH // bcrypt hash of admin password
const USE_DB       = !!process.env.DATABASE_URL      // use PostgreSQL if available

// ── Cache (Notion fallback) ───────────────────────────────────────────────
let notionCache = { data: null, at: 0 }
const CACHE_TTL = 15 * 60 * 1000

// ── Middleware ────────────────────────────────────────────────────────────
app.use(express.json({ limit: '12mb' }))
app.use(express.static(join(__dirname, 'public')))

// ── Auth middleware ───────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' })
  try {
    req.admin = jwt.verify(auth.slice(7), JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'Token inválido' })
  }
}

// ── Notion helpers (fallback) ─────────────────────────────────────────────
async function notionQuery(dbId) {
  const pages = []
  let cursor
  while (true) {
    const body = { page_size: 100 }
    if (cursor) body.start_cursor = cursor
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`)
    const data = await res.json()
    pages.push(...data.results)
    if (!data.has_more) break
    cursor = data.next_cursor
  }
  return pages
}

function richText(prop) {
  if (!prop) return ''
  const items = prop.rich_text ?? prop.title
  if (items) return items.map(i => i.plain_text).join('').trim()
  if (prop.select?.name) return prop.select.name.trim()
  if (prop.multi_select?.length) return prop.multi_select.map(s => s.name).join(', ').trim()
  return ''
}
function fileUrl(prop) {
  if (!prop?.files?.length) return null
  const f = prop.files[0]
  return f.type === 'file' ? f.file?.url : f.external?.url ?? null
}
function relationIds(prop) {
  return (prop?.relation ?? []).map(r => r.id)
}

async function buildNotionLibrary() {
  const [bookPages, quotePages] = await Promise.all([
    notionQuery(BOOKS_DB),
    notionQuery(QUOTES_DB),
  ])
  const books = bookPages
    .map(p => ({
      id:       p.id,
      nombre:   richText(p.properties.Nombre),
      author:   richText(p.properties.Author ?? p.properties.Autor ?? p.properties.Autores),
      rating:   p.properties['My Rating']?.number ?? p.properties['Valoración']?.number ?? null,
      portada:  fileUrl(p.properties.Portada),
      shelf:    p.properties['Exclusive Shelf']?.select?.name ?? null,
      dateRead: p.properties['Date Read']?.date?.start ?? null,
      quotes:   [],
    }))
    .filter(b => b.nombre.trim())

  if (bookPages.length > 0) {
    console.log('📖 Notion book fields:', Object.keys(bookPages[0].properties).join(', '))
  }

  const bookMap = new Map(books.map(b => [b.id, b]))
  for (const p of quotePages) {
    const cita = richText(p.properties.Cita)
    if (!cita.trim()) continue
    const q = {
      id:         p.id,
      cita,
      autor:      richText(p.properties.Autor),
      obra:       richText(p.properties.Obra),
      pagina:     p.properties['Página']?.number ?? null,
      categorias: p.properties['Categoría']?.multi_select?.map(s => s.name) ?? [],
      favorita:   p.properties.Favorita?.checkbox ?? false,
      bookIds:    relationIds(p.properties.Libro),
    }
    for (const bid of q.bookIds) bookMap.get(bid)?.quotes.push(q)
  }

  return books
    .filter(b => b.quotes.length > 0)
    .sort((a, b) => {
      if (a.dateRead && b.dateRead) return b.dateRead.localeCompare(a.dateRead)
      if (a.dateRead) return -1
      if (b.dateRead) return 1
      return 0
    })
}

async function getNotionData() {
  if (notionCache.data && Date.now() - notionCache.at < CACHE_TTL) return notionCache.data
  const data = await buildNotionLibrary()
  notionCache = { data, at: Date.now() }
  return data
}

// ── Data source (DB o Notion) ─────────────────────────────────────────────
async function getData() {
  if (USE_DB) return getLibrary()
  return getNotionData()
}

async function getRandomData(n = 3) {
  if (USE_DB) return getRandomQuotes(n)
  const library = await getNotionData()
  const allQuotes = library.flatMap(b =>
    b.quotes.map(q => ({
      ...q,
      bookIds:    [b.id],
      bookNombre: b.nombre,
      bookPortada: b.portada,
    }))
  )
  return allQuotes.sort(() => Math.random() - 0.5).slice(0, n)
}

// ── Auth routes ───────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { password } = req.body
  if (!ADMIN_HASH) return res.status(503).json({ error: 'Admin no configurado. Añade ADMIN_PASSWORD_HASH.' })
  const ok = await bcrypt.compare(password, ADMIN_HASH)
  if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta' })
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '30d' })
  res.json({ token })
})

// Util: genera el hash de una contraseña (solo en desarrollo)
app.get('/api/auth/hash/:pw', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).end()
  bcrypt.hash(req.params.pw, 10).then(h => res.json({ hash: h }))
})

// ── Public API ────────────────────────────────────────────────────────────
app.get('/api/library', async (req, res) => {
  try { res.json(await getData()) }
  catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

app.get('/api/random', async (req, res) => {
  try { res.json(await getRandomData()) }
  catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

// Toggle favorite — escribe a Notion si es fallback, a PG si es BD propia
app.patch('/api/quotes/:id/favorite', async (req, res) => {
  const { id } = req.params
  const { favorita } = req.body
  if (typeof favorita !== 'boolean') return res.status(400).json({ error: '`favorita` must be boolean' })

  try {
    if (USE_DB) {
      await pool.query('UPDATE quotes SET favorita=$1, updated_at=NOW() WHERE id=$2', [favorita, id])
    } else {
      const r = await fetch(`https://api.notion.com/v1/pages/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: { Favorita: { checkbox: favorita } } }),
      })
      if (!r.ok) throw new Error(await r.text())
      // Update cache
      if (notionCache.data) {
        for (const b of notionCache.data) {
          const q = b.quotes.find(q => q.id === id)
          if (q) { q.favorita = favorita; break }
        }
      }
    }
    res.json({ ok: true, favorita })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

// ── Admin: Books CRUD ─────────────────────────────────────────────────────
app.post('/api/books', requireAdmin, async (req, res) => {
  const { titulo, autor, portada_url, valoracion, estado, fecha_lectura, numero_paginas, my_review } = req.body
  if (!titulo?.trim()) return res.status(400).json({ error: 'titulo requerido' })
  try {
    const { rows } = await pool.query(
      `INSERT INTO books (titulo, autor, portada_url, valoracion, estado, fecha_lectura, numero_paginas, my_review)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [titulo.trim(), autor?.trim() || null, portada_url || null,
       valoracion || null, estado || 'Leído', fecha_lectura || null,
       numero_paginas || null, my_review?.trim() || null]
    )
    res.status(201).json(rows[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.put('/api/books/:id', requireAdmin, async (req, res) => {
  const { titulo, autor, portada_url, valoracion, estado, fecha_lectura, numero_paginas, my_review } = req.body
  try {
    const { rows } = await pool.query(
      `UPDATE books SET titulo=$1, autor=$2, portada_url=$3, valoracion=$4,
       estado=$5, fecha_lectura=$6, numero_paginas=$7, my_review=$8, updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [titulo, autor, portada_url, valoracion, estado, fecha_lectura,
       numero_paginas, my_review, req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Libro no encontrado' })
    res.json(rows[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.delete('/api/books/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM books WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Admin: Quotes CRUD ────────────────────────────────────────────────────
app.post('/api/books/:bookId/quotes', requireAdmin, async (req, res) => {
  const { cita, pagina, categorias, favorita } = req.body
  if (!cita?.trim()) return res.status(400).json({ error: 'cita requerida' })
  try {
    const { rows } = await pool.query(
      `INSERT INTO quotes (book_id, cita, pagina, categorias, favorita, fuente)
       VALUES ($1,$2,$3,$4,$5,'manual') RETURNING *`,
      [req.params.bookId, cita.trim(), pagina || null,
       categorias || [], favorita || false]
    )
    res.status(201).json(rows[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.put('/api/quotes/:id', requireAdmin, async (req, res) => {
  const { cita, pagina, categorias, favorita } = req.body
  try {
    const { rows } = await pool.query(
      `UPDATE quotes SET cita=$1, pagina=$2, categorias=$3, favorita=$4,
       updated_at=NOW() WHERE id=$5 RETURNING *`,
      [cita, pagina, categorias, favorita, req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Cita no encontrada' })
    res.json(rows[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.delete('/api/quotes/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM quotes WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Admin: Import Kindle JSON ─────────────────────────────────────────────
// Formato: [{ titulo, autor, highlights: [{ text, page }] }]
app.post('/api/import/kindle', requireAdmin, async (req, res) => {
  const { books: kindleBooks } = req.body
  if (!Array.isArray(kindleBooks)) return res.status(400).json({ error: 'Se espera { books: [...] }' })

  let imported = 0, skipped = 0
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    for (const kb of kindleBooks) {
      if (!kb.titulo?.trim()) continue

      // Buscar o crear libro
      let { rows } = await client.query(
        'SELECT id FROM books WHERE LOWER(titulo)=LOWER($1) AND LOWER(COALESCE(autor,\'\'))=LOWER($2)',
        [kb.titulo.trim(), (kb.autor || '').trim()]
      )

      let bookId
      if (rows.length) {
        bookId = rows[0].id
      } else {
        const ins = await client.query(
          'INSERT INTO books (titulo, autor, estado) VALUES ($1,$2,\'Leído\') RETURNING id',
          [kb.titulo.trim(), kb.autor?.trim() || null]
        )
        bookId = ins.rows[0].id
      }

      for (const h of (kb.highlights || [])) {
        if (!h.text?.trim()) continue
        // Evitar duplicados exactos
        const dup = await client.query(
          'SELECT id FROM quotes WHERE book_id=$1 AND cita=$2',
          [bookId, h.text.trim()]
        )
        if (dup.rows.length) { skipped++; continue }

        await client.query(
          'INSERT INTO quotes (book_id, cita, pagina, fuente) VALUES ($1,$2,$3,\'kindle\')',
          [bookId, h.text.trim(), h.page || null]
        )
        imported++
      }
    }

    await client.query('COMMIT')
    res.json({ ok: true, imported, skipped })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: err.message })
  } finally {
    client.release()
  }
})

// ── Admin: Export to Notion ───────────────────────────────────────────────
app.post('/api/sync/notion', requireAdmin, async (req, res) => {
  // TODO: implementar exportación a Notion
  res.json({ ok: true, message: 'Sync to Notion — próximamente' })
})

// ── Cache refresh ─────────────────────────────────────────────────────────
app.post('/api/refresh', async (req, res) => {
  notionCache = { data: null, at: 0 }
  try { await getData(); res.json({ ok: true }) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

// ── SPA fallback ──────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')))

// ── Start ─────────────────────────────────────────────────────────────────
const startServer = async () => {
  if (USE_DB) {
    await initDB()
    console.log('🗄️  Usando PostgreSQL')
  } else {
    console.log('📋  Usando Notion como fuente (sin DATABASE_URL)')
  }

  app.listen(PORT, () => {
    console.log(`📚 Noray en http://localhost:${PORT}`)
    getData()
      .then(d => console.log(`✅ Datos listos: ${d.length} libros`))
      .catch(err => console.error('⚠️  Error precargando:', err.message))

    if (!USE_DB) {
      setInterval(() => {
        notionCache = { data: null, at: 0 }
        getData().catch(err => console.error('⚠️  Refresh error:', err.message))
      }, 12 * 60 * 1000)
    }
  })
}

startServer()
