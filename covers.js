// covers.js — reduce portadas base64 a WebP ligeros (~30-40 KB en vez de ~1 MB)
import sharp from 'sharp'

const MAX_WIDTH    = 400
const QUALITY      = 75
const SHRINK_ABOVE = 80_000   // caracteres base64 (~60 KB); por debajo ya está optimizada

// Devuelve el data URL reducido, o el original si no es base64 o ya es pequeño
export async function shrinkDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:') || dataUrl.length <= SHRINK_ABOVE) {
    return dataUrl
  }
  const input = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
  const out = await sharp(input)
    .rotate()
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toBuffer()
  return `data:image/webp;base64,${out.toString('base64')}`
}

// Pasada única en segundo plano: reduce las portadas grandes de una en una
// (sin cargarlas todas en memoria) y compacta la tabla al terminar.
export async function shrinkStoredCovers(pool, onShrunk = () => {}) {
  const { rows } = await pool.query(
    `SELECT id FROM books WHERE portada_url LIKE 'data:%' AND length(portada_url) > $1`,
    [SHRINK_ABOVE]
  )
  if (!rows.length) return
  console.log(`🗜️  Reduciendo ${rows.length} portadas…`)
  let ok = 0, before = 0, after = 0
  for (const { id } of rows) {
    try {
      const { rows: [book] } = await pool.query('SELECT portada_url FROM books WHERE id=$1', [id])
      if (!book?.portada_url) continue
      const small = await shrinkDataUrl(book.portada_url)
      if (small === book.portada_url) continue
      await pool.query('UPDATE books SET portada_url=$1 WHERE id=$2', [small, id])
      before += book.portada_url.length
      after  += small.length
      ok++
      onShrunk(id)
    } catch (err) {
      console.error(`⚠️  Portada ${id}:`, err.message)
    }
  }
  console.log(`✅ ${ok} portadas reducidas: ${(before / 1e6).toFixed(0)} MB → ${(after / 1e6).toFixed(1)} MB`)
  // Devuelve el espacio al disco (sin esto Postgres conserva el tamaño antiguo)
  await pool.query('VACUUM FULL books')
  console.log('✅ Tabla books compactada')
}
