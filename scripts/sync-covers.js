#!/usr/bin/env node
/**
 * sync-covers.js
 * Descarga todas las portadas de la BD de Libros de Notion
 * y las guarda como base64 en PostgreSQL.
 *
 * Uso:
 *   DATABASE_URL="..." NOTION_TOKEN="..." node scripts/sync-covers.js
 *
 * Opciones:
 *   --force   Volver a descargar aunque ya tengan portada en la BD
 *   --limit N Procesar solo los primeros N libros
 */

import pg from 'pg'

const { Pool } = pg
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

const NOTION_TOKEN = process.env.NOTION_TOKEN
const BOOKS_DB     = process.env.NOTION_BOOKS_DB || '2b21bd2a8d4f80a5ba96f19f6ad4dac7'
const FORCE        = process.argv.includes('--force')
const LIMIT        = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1]) || Infinity

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
    if (!res.ok) throw new Error(`Notion ${res.status}`)
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
  if (!prop) return ''
  const items = prop.rich_text ?? prop.title
  if (items) return items.map(i => i.plain_text).join('').trim()
  if (prop.select?.name) return prop.select.name.trim()
  return ''
}

async function downloadAsBase64(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const contentType = res.headers.get('content-type') || 'image/jpeg'
  const buf = Buffer.from(await res.arrayBuffer())
  return `data:${contentType};base64,${buf.toString('base64')}`
}

async function run() {
  console.log('🖼️  Sincronizando portadas Notion → PostgreSQL\n')

  // 1. Libros en BD local que no tienen portada (o todos si --force)
  const { rows: dbBooks } = await pool.query(
    FORCE
      ? 'SELECT id, titulo, notion_id FROM books WHERE notion_id IS NOT NULL ORDER BY titulo'
      : `SELECT id, titulo, notion_id FROM books
         WHERE notion_id IS NOT NULL
           AND (portada_url IS NULL OR portada_url NOT LIKE 'data:%')
         ORDER BY titulo`
  )

  if (!dbBooks.length) {
    console.log('✅ Todos los libros ya tienen portada almacenada. Usa --force para refrescar.')
    await pool.end(); return
  }
  console.log(`📚 ${dbBooks.length} libros a procesar${FORCE?' (--force: todos)':' (sin portada o URL expirada)'}`)

  // 2. Obtener URLs frescas de Notion
  console.log('🔄 Obteniendo URLs frescas de Notion...')
  const notionPages = await notionQuery(BOOKS_DB)
  const notionMap = new Map(notionPages.map(p => [p.id.replace(/-/g,''), p]))
  console.log(`   ${notionPages.length} libros en Notion\n`)

  // 3. Descargar y guardar
  let ok = 0, skipped = 0, errors = 0
  const toProcess = dbBooks.slice(0, LIMIT)

  for (let i = 0; i < toProcess.length; i++) {
    const book = toProcess[i]
    const notionPage = notionMap.get(book.notion_id?.replace(/-/g,''))
    if (!notionPage) { skipped++; continue }

    const coverUrl = fileUrl(notionPage.properties.Portada ?? notionPage.properties.Cover ?? notionPage.properties.Imagen)
    if (!coverUrl) { skipped++; continue }

    process.stdout.write(`[${i+1}/${toProcess.length}] ${book.titulo.substring(0,40).padEnd(40)} `)
    try {
      const base64 = await downloadAsBase64(coverUrl)
      await pool.query('UPDATE books SET portada_url=$1, updated_at=NOW() WHERE id=$2', [base64, book.id])
      const kb = Math.round(base64.length * 0.75 / 1024)
      console.log(`✓ ${kb}KB`)
      ok++
      // Pequeña pausa para no saturar Notion
      if (i % 10 === 9) await new Promise(r => setTimeout(r, 300))
    } catch (err) {
      console.log(`✗ ${err.message}`)
      errors++
    }
  }

  console.log(`\n✅ ${ok} portadas guardadas · ${skipped} sin portada en Notion · ${errors} errores`)
  await pool.end()
}

run().catch(err => { console.error('❌', err.message); process.exit(1) })
