#!/usr/bin/env node
/**
 * migrate-from-notion.js
 * Importa todos los libros y citas de Notion → PostgreSQL
 *
 * Uso:
 *   DATABASE_URL=... NOTION_TOKEN=... node scripts/migrate-from-notion.js
 */

import pg from 'pg'

const { Pool } = pg
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

const NOTION_TOKEN = process.env.NOTION_TOKEN
const QUOTES_DB    = process.env.NOTION_QUOTES_DB || 'e79059209139461fb2c17d39bf0fe687'
const BOOKS_DB     = process.env.NOTION_BOOKS_DB  || '2b21bd2a8d4f80a5ba96f19f6ad4dac7'

const headers = {
  Authorization: `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
}

async function notionQuery(dbId) {
  const pages = []
  let cursor
  while (true) {
    const body = { page_size: 100 }
    if (cursor) body.start_cursor = cursor
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST', headers, body: JSON.stringify(body),
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
  // rich_text o title
  const items = prop.rich_text ?? prop.title
  if (items) return items.map(i => i.plain_text).join('').trim()
  // select
  if (prop.select?.name) return prop.select.name.trim()
  // multi_select → join con coma
  if (prop.multi_select?.length) return prop.multi_select.map(s => s.name).join(', ').trim()
  return ''
}
function fileUrl(prop) {
  if (!prop?.files?.length) return null
  const f = prop.files[0]
  return f.type === 'file' ? f.file?.url : f.external?.url ?? null
}

async function run() {
  console.log('🚀 Iniciando migración Notion → PostgreSQL\n')

  // ── Crear tablas ──────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS books (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      titulo TEXT NOT NULL, autor TEXT, portada_url TEXT,
      valoracion SMALLINT CHECK (valoracion BETWEEN 1 AND 5),
      estado TEXT DEFAULT 'Leído', fecha_lectura DATE,
      notion_id TEXT UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS quotes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      book_id UUID REFERENCES books(id) ON DELETE CASCADE,
      cita TEXT NOT NULL, pagina INTEGER, categorias TEXT[] DEFAULT '{}',
      favorita BOOLEAN DEFAULT FALSE, fuente TEXT DEFAULT 'notion',
      notion_id TEXT UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_quotes_book_id ON quotes(book_id);
  `)
  console.log('✅ Tablas listas\n')

  // ── Libros ────────────────────────────────────────────────────────────────
  console.log(`📚 Leyendo BD de Libros: ${BOOKS_DB.slice(0,8)}...`)
  const bookPages = await notionQuery(BOOKS_DB)
  console.log(`   ${bookPages.length} libros en Notion`)
  if (bookPages.length > 0) {
    console.log('   Campos:', Object.keys(bookPages[0].properties).join(', '))
  }

  const notionIdToDbId = new Map()
  let booksInserted = 0, booksSkipped = 0

  for (const p of bookPages) {
    const titulo = richText(p.properties.Nombre ?? p.properties.Título ?? p.properties.Name)
    if (!titulo) { booksSkipped++; continue }

    const autor = richText(p.properties.Author ?? p.properties.Autor ?? p.properties.Autores)
    const valoracion = p.properties['My Rating']?.number ?? p.properties['Valoración']?.number ?? null
    const estado = p.properties['Exclusive Shelf']?.select?.name ?? p.properties.Estado?.select?.name ?? 'Leído'
    const fecha = p.properties['Date Read']?.date?.start ?? p.properties['Fecha de lectura']?.date?.start ?? null
    const portada = fileUrl(p.properties.Portada ?? p.properties.Cover)
    const notionId = p.id

    const { rows } = await pool.query(
      `INSERT INTO books (titulo, autor, portada_url, valoracion, estado, fecha_lectura, notion_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (notion_id) DO UPDATE SET
         titulo=EXCLUDED.titulo, autor=EXCLUDED.autor, valoracion=EXCLUDED.valoracion,
         updated_at=NOW()
       RETURNING id`,
      [titulo, autor || null, portada, valoracion, estado, fecha, notionId]
    )
    notionIdToDbId.set(notionId, rows[0].id)
    booksInserted++
  }
  console.log(`   ✅ ${booksInserted} libros importados, ${booksSkipped} omitidos\n`)

  // ── Citas ─────────────────────────────────────────────────────────────────
  console.log(`📝 Leyendo BD de Citas: ${QUOTES_DB.slice(0,8)}...`)
  const quotePages = await notionQuery(QUOTES_DB)
  console.log(`   ${quotePages.length} citas en Notion`)
  if (quotePages.length > 0) {
    console.log('   Campos:', Object.keys(quotePages[0].properties).join(', '))
  }

  let quotesInserted = 0, quotesSkipped = 0

  for (const p of quotePages) {
    const cita = richText(p.properties.Cita ?? p.properties.Name)
    if (!cita) { quotesSkipped++; continue }

    // Buscar el libro via relación o via campo Obra
    let bookId = null
    const libroRelation = (p.properties.Libro?.relation ?? []).map(r => r.id)
    for (const nid of libroRelation) {
      if (notionIdToDbId.has(nid)) { bookId = notionIdToDbId.get(nid); break }
    }

    // Fallback: buscar por título de obra
    if (!bookId) {
      const obra = richText(p.properties.Obra)
      if (obra) {
        const { rows } = await pool.query(
          'SELECT id FROM books WHERE LOWER(titulo)=LOWER($1) LIMIT 1', [obra]
        )
        if (rows.length) bookId = rows[0].id
      }
    }

    if (!bookId) { quotesSkipped++; continue }

    const pagina = p.properties['Página']?.number ?? null
    const cats = p.properties['Categoría']?.multi_select?.map(s => s.name) ?? []
    const fav = p.properties.Favorita?.checkbox ?? false

    await pool.query(
      `INSERT INTO quotes (book_id, cita, pagina, categorias, favorita, fuente, notion_id)
       VALUES ($1,$2,$3,$4,$5,'notion',$6)
       ON CONFLICT (notion_id) DO UPDATE SET
         cita=EXCLUDED.cita, pagina=EXCLUDED.pagina, favorita=EXCLUDED.favorita,
         updated_at=NOW()`,
      [bookId, cita, pagina, cats, fav, p.id]
    )
    quotesInserted++
  }
  console.log(`   ✅ ${quotesInserted} citas importadas, ${quotesSkipped} omitidas\n`)

  console.log('🎉 Migración completada')
  await pool.end()
}

run().catch(err => { console.error('❌', err.message); process.exit(1) })
