import { SCHEMA } from './schema.js'

/* Postgres access.
   - Production (Vercel): Neon over HTTP — no connection pool to manage.
   - Local dev and tests (no DATABASE_URL): PGlite, real Postgres compiled to
     WebAssembly running in-process, so `npm run dev` needs no database setup.
     Stored in .data/pglite unless PGLITE_DIR says otherwise ('memory://' in tests).
   Every row-level race in the booking flow is settled by single atomic
   statements (UPDATE … WHERE status = … RETURNING), which behave the same on both. */

// Held in a variable so Vercel's bundler doesn't trace PGlite's ~10 MB of
// WebAssembly into the production function.
const PGLITE = '@electric-sql/pglite'

async function init() {
  if (process.env.DATABASE_URL) {
    const { neon } = await import('@neondatabase/serverless')
    const sql = neon(process.env.DATABASE_URL)
    return (text, params) => sql.query(text, params)
  }
  if (process.env.VERCEL) throw new Error('DATABASE_URL is not set')
  const { PGlite } = await import(/* @vite-ignore */ PGLITE)
  const dir = process.env.PGLITE_DIR || '.data/pglite'
  // PGlite creates its own folder but not missing parents (.data/).
  if (!dir.includes('://')) (await import('node:fs')).mkdirSync(dir, { recursive: true })
  const db = new PGlite(dir)
  for (const stmt of SCHEMA) await db.query(stmt)
  return async (text, params) => (await db.query(text, params)).rows
}

/** Runs one SQL statement and returns its rows. */
export async function q(text, params = []) {
  // Kept on globalThis so the Vite dev server's module reloads reuse one
  // database instead of opening .data/pglite twice.
  globalThis.__flightsDb ??= init()
  return (await globalThis.__flightsDb)(text, params)
}

/** First row or null. */
export async function one(text, params) {
  return (await q(text, params))[0] ?? null
}

/** Applies the schema (used by scripts/db-migrate.mjs against Neon). */
export async function migrate() {
  for (const stmt of SCHEMA) await q(stmt)
}

/* ---------- Leases: "only one request does this job right now" ----------
   INSERT … ON CONFLICT DO UPDATE … WHERE the old lease has expired is a
   single atomic statement, so exactly one caller gets a row back. */
export async function tryLease(name, seconds) {
  const row = await one(
    `insert into kv (key, value, expires_at) values ($1, 'true', now() + make_interval(secs => $2))
     on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at
       where kv.expires_at is null or kv.expires_at < now()
     returning key`,
    [`lease:${name}`, seconds],
  )
  return Boolean(row)
}

export async function releaseLease(name) {
  await q(`delete from kv where key = $1`, [`lease:${name}`])
}
