import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb } from './client.js'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required')

// max: 1 — migrations must run on a single connection, in order.
const { db, close } = createDb(url, { max: 1 })
await migrate(db, { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
await close()
console.log('migrations applied')
