// db.js — PostgreSQL connection and schema init
import pg from 'pg'
const { Pool } = pg

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
})

export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS books (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      titulo         TEXT NOT NULL,
      autor          TEXT,
      portada_url    TEXT,
      valoracion     SMALLINT CHECK (valoracion BETWEEN 1 AND 5),
      estado         TEXT DEFAULT 'Leído',
      fecha_lectura  DATE,
      numero_paginas INTEGER,
      my_review      TEXT,
      notion_id      TEXT UNIQUE,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    );
    -- Añadir columnas nuevas si la tabla ya existía
    ALTER TABLE books ADD COLUMN IF NOT EXISTS numero_paginas INTEGER;
    ALTER TABLE books ADD COLUMN IF NOT EXISTS my_review TEXT;

    CREATE TABLE IF NOT EXISTS quotes (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      book_id     UUID REFERENCES books(id) ON DELETE CASCADE,
      cita        TEXT NOT NULL,
      pagina      INTEGER,
      categorias  TEXT[] DEFAULT '{}',
      favorita    BOOLEAN DEFAULT FALSE,
      fuente      TEXT DEFAULT 'manual',
      notion_id   TEXT UNIQUE,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_quotes_book_id ON quotes(book_id);
    CREATE INDEX IF NOT EXISTS idx_quotes_favorita ON quotes(favorita);
  `)
  console.log('✅ DB schema ready')
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export async function getLibrary() {
  const { rows: books } = await pool.query(`
    SELECT b.id,
           b.titulo,
           b.autor,
           b.valoracion,
           b.estado,
           b.fecha_lectura,
           b.numero_paginas,
           b.my_review,
           b.publisher,
           b.binding,
           b.notion_id,
           b.created_at,
           -- Nunca traer el base64 completo: convertir en SQL
           CASE
             WHEN b.portada_url LIKE 'data:%' THEN '/api/covers/' || b.id::text
             ELSE b.portada_url
           END AS portada_computed,
           COUNT(q.id)::int AS ncitas,
           jsonb_agg(
             jsonb_build_object(
               'id',         q.id,
               'cita',       q.cita,
               'pagina',     q.pagina,
               'categorias', q.categorias,
               'favorita',   q.favorita,
               'fuente',     q.fuente,
               'book_id',    q.book_id,
               'bookIds',    jsonb_build_array(q.book_id::text)
             ) ORDER BY q.created_at
           ) FILTER (WHERE q.id IS NOT NULL) AS quotes
    FROM books b
    LEFT JOIN quotes q ON q.book_id = b.id
    GROUP BY b.id
    ORDER BY b.fecha_lectura DESC NULLS LAST, b.created_at DESC
  `)

  return books.map(b => ({
    id:            b.id,
    nombre:        b.titulo,
    author:        b.autor,
    portada:       b.portada_computed || null,
    rating:        b.valoracion,
    shelf:         b.estado,
    dateRead:      b.fecha_lectura,
    numeroPaginas: b.numero_paginas,
    myReview:      b.my_review,
    publisher:     b.publisher,
    binding:       b.binding,
    quotes:        b.quotes || [],
  }))
}

export async function getRandomQuotes(n = 3) {
  const { rows } = await pool.query(`
    SELECT q.*,
           b.titulo     AS book_nombre,
           b.autor      AS book_autor,
           b.portada_url AS book_portada
    FROM quotes q
    JOIN books b ON b.id = q.book_id
    ORDER BY RANDOM()
    LIMIT $1
  `, [n])

  return rows.map(q => ({
    id:          q.id,
    cita:        q.cita,
    autor:       q.book_autor || '',
    obra:        q.book_nombre,
    pagina:      q.pagina,
    categorias:  q.categorias,
    favorita:    q.favorita,
    bookIds:     [q.book_id],
    bookNombre:  q.book_nombre,
    bookPortada: q.book_portada
      ? (q.book_portada.startsWith('data:') ? `/api/covers/${q.book_id}` : q.book_portada)
      : null,
  }))
}
