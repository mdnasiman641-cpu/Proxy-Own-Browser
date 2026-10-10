import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BindParams, Database, SqlJsStatic, SqlValue } from 'sql.js'

export type Row = Record<string, SqlValue>

interface Migration {
  version: number
  sql: string
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE profiles (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        name_key        TEXT NOT NULL UNIQUE,
        notes           TEXT NOT NULL DEFAULT '',
        color           TEXT NOT NULL,
        start_url       TEXT,
        partition       TEXT NOT NULL UNIQUE,
        proxy_protocol  TEXT,
        proxy_host      TEXT,
        proxy_port      INTEGER,
        proxy_username  TEXT,
        proxy_password  TEXT,
        proxy_bypass    TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        last_opened_at  TEXT
      );
      CREATE INDEX idx_profiles_name ON profiles (name_key);
      -- Every partition ever issued, so a deleted profile's partition is never reused.
      CREATE TABLE used_partitions (
        partition   TEXT PRIMARY KEY,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE settings (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
      );
    `
  }
]

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version

export interface OpenDatabaseResult {
  db: AppDatabase
  /** Set when an unreadable database file was moved aside and a new one created. */
  recoveredFrom?: string
}

/**
 * SQLite storage backed by sql.js (WebAssembly — no native module to rebuild for Electron).
 * The database lives in memory and is written to disk atomically after every change.
 */
export class AppDatabase {
  private inTransaction = false

  private constructor(
    private readonly db: Database,
    private readonly filePath: string | null
  ) {}

  /** Opens (or creates) a database. Pass `null` as filePath for an in-memory database. */
  static open(SQL: SqlJsStatic, filePath: string | null): OpenDatabaseResult {
    if (filePath && existsSync(filePath)) {
      try {
        const db = new AppDatabase(new SQL.Database(readFileSync(filePath)), filePath)
        db.migrate()
        return { db }
      } catch {
        // The file is not a readable SQLite database. Keep it for inspection and start fresh.
        const aside = `${filePath}.corrupt-${Date.now()}`
        renameSync(filePath, aside)
        const db = new AppDatabase(new SQL.Database(), filePath)
        db.migrate()
        return { db, recoveredFrom: aside }
      }
    }
    const db = new AppDatabase(new SQL.Database(), filePath)
    db.migrate()
    return { db }
  }

  get schemaVersion(): number {
    const row = this.get<{ user_version: number }>('PRAGMA user_version')
    return Number(row?.user_version ?? 0)
  }

  all<T = Row>(sql: string, params: BindParams = []): T[] {
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params)
      const rows: T[] = []
      while (stmt.step()) rows.push(stmt.getAsObject() as T)
      return rows
    } finally {
      stmt.free()
    }
  }

  get<T = Row>(sql: string, params: BindParams = []): T | undefined {
    return this.all<T>(sql, params)[0]
  }

  /** Executes a write statement and persists to disk (unless inside a transaction). */
  run(sql: string, params: BindParams = []): number {
    this.db.run(sql, params)
    const changes = this.db.getRowsModified()
    if (!this.inTransaction) this.persist()
    return changes
  }

  /** Runs `fn` atomically: all writes are committed and persisted together, or none are. */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn()
    this.db.run('BEGIN')
    this.inTransaction = true
    try {
      const result = fn()
      this.db.run('COMMIT')
      this.inTransaction = false
      this.persist()
      return result
    } catch (error) {
      this.inTransaction = false
      this.db.run('ROLLBACK')
      throw error
    }
  }

  /** Writes the database to disk via a temp file + rename so a crash never leaves a half-written file. */
  persist(): void {
    if (!this.filePath) return
    const data = this.db.export()
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, data)
    replaceFile(tmp, this.filePath)
  }

  close(): void {
    this.persist()
    this.db.close()
  }

  private migrate(): void {
    const current = this.schemaVersion
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue
      this.transaction(() => {
        this.db.exec(migration.sql)
        this.db.run(`PRAGMA user_version = ${migration.version}`)
      })
    }
  }
}

/** rename() can briefly fail on Windows while antivirus/indexers hold the file. */
function replaceFile(from: string, to: string): void {
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      lastError = error
      const until = Date.now() + 40 * (attempt + 1)
      while (Date.now() < until) {
        /* short synchronous back-off */
      }
    }
  }
  try {
    unlinkSync(from)
  } catch {
    /* ignore */
  }
  throw lastError
}
