/* Creates/updates the flight-booking tables in the database at DATABASE_URL
   (Neon). Safe to run any number of times. Usage:
   DATABASE_URL=postgres://… npm run db:migrate   (or put it in .env.local) */
import { readFileSync, existsSync } from 'node:fs'

if (!process.env.DATABASE_URL && existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/)
    if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, '')
  }
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (put it in .env.local or the environment).')
  process.exit(1)
}
const { migrate } = await import('../server/db.js')
await migrate()
console.log('Flight booking tables are ready.')
