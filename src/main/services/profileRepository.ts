import type { AppDatabase } from './database'
import type { ProxyProtocol } from '@shared/types'

/** A profile row exactly as stored. `proxyPassword` is the encrypted value. */
export interface ProfileRecord {
  id: string
  name: string
  notes: string
  color: string
  startUrl: string | null
  partition: string
  proxyProtocol: ProxyProtocol | null
  proxyHost: string | null
  proxyPort: number | null
  proxyUsername: string | null
  proxyPassword: string | null
  proxyBypass: string
  groupId: string | null
  /** JSON-encoded BrowserConfig (validated when read). */
  browserConfig: string
  createdAt: string
  updatedAt: string
  lastOpenedAt: string | null
}

interface ProfileRow {
  id: string
  name: string
  notes: string
  color: string
  start_url: string | null
  partition: string
  proxy_protocol: string | null
  proxy_host: string | null
  proxy_port: number | null
  proxy_username: string | null
  proxy_password: string | null
  proxy_bypass: string
  group_id: string | null
  browser_config: string
  created_at: string
  updated_at: string
  last_opened_at: string | null
}

const COLUMNS = `id, name, notes, color, start_url, partition, proxy_protocol, proxy_host, proxy_port,
  proxy_username, proxy_password, proxy_bypass, group_id, browser_config, created_at, updated_at, last_opened_at`

function fromRow(row: ProfileRow): ProfileRecord {
  return {
    id: row.id,
    name: row.name,
    notes: row.notes,
    color: row.color,
    startUrl: row.start_url,
    partition: row.partition,
    proxyProtocol: (row.proxy_protocol as ProxyProtocol | null) ?? null,
    proxyHost: row.proxy_host,
    proxyPort: row.proxy_port === null ? null : Number(row.proxy_port),
    proxyUsername: row.proxy_username,
    proxyPassword: row.proxy_password,
    proxyBypass: row.proxy_bypass,
    groupId: row.group_id ?? null,
    browserConfig: row.browser_config ?? '{}',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at
  }
}

export function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase()
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export class ProfileRepository {
  constructor(private readonly db: AppDatabase) {}

  findAll(): ProfileRecord[] {
    return this.db
      .all<ProfileRow>(`SELECT ${COLUMNS} FROM profiles ORDER BY name_key ASC, created_at ASC`)
      .map(fromRow)
  }

  search(query: string): ProfileRecord[] {
    const like = `%${escapeLike(query.trim().toLocaleLowerCase())}%`
    return this.db
      .all<ProfileRow>(
        `SELECT ${COLUMNS} FROM profiles
         WHERE name_key LIKE ? ESCAPE '\\'
            OR lower(notes) LIKE ? ESCAPE '\\'
            OR lower(coalesce(proxy_host, '')) LIKE ? ESCAPE '\\'
         ORDER BY name_key ASC, created_at ASC`,
        [like, like, like]
      )
      .map(fromRow)
  }

  findById(id: string): ProfileRecord | undefined {
    const row = this.db.get<ProfileRow>(`SELECT ${COLUMNS} FROM profiles WHERE id = ?`, [id])
    return row ? fromRow(row) : undefined
  }

  count(): number {
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM profiles')?.n ?? 0)
  }

  isNameTaken(name: string, excludeId?: string): boolean {
    const row = this.db.get(
      'SELECT 1 AS hit FROM profiles WHERE name_key = ? AND id != ?',
      [nameKey(name), excludeId ?? '']
    )
    return row !== undefined
  }

  isPartitionUsed(partition: string): boolean {
    return (
      this.db.get('SELECT 1 AS hit FROM used_partitions WHERE partition = ?', [partition]) !==
      undefined
    )
  }

  insert(record: ProfileRecord): void {
    this.db.transaction(() => {
      this.db.run('INSERT INTO used_partitions (partition, created_at) VALUES (?, ?)', [
        record.partition,
        record.createdAt
      ])
      this.db.run(
        `INSERT INTO profiles (${COLUMNS}, name_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [...toParams(record), nameKey(record.name)]
      )
    })
  }

  update(record: ProfileRecord): void {
    this.db.run(
      `UPDATE profiles SET
         name = ?, name_key = ?, notes = ?, color = ?, start_url = ?,
         proxy_protocol = ?, proxy_host = ?, proxy_port = ?, proxy_username = ?, proxy_password = ?,
         proxy_bypass = ?, group_id = ?, browser_config = ?, updated_at = ?, last_opened_at = ?
       WHERE id = ?`,
      [
        record.name,
        nameKey(record.name),
        record.notes,
        record.color,
        record.startUrl,
        record.proxyProtocol,
        record.proxyHost,
        record.proxyPort,
        record.proxyUsername,
        record.proxyPassword,
        record.proxyBypass,
        record.groupId,
        record.browserConfig,
        record.updatedAt,
        record.lastOpenedAt,
        record.id
      ]
    )
  }

  setLastOpened(id: string, timestamp: string): void {
    this.db.run('UPDATE profiles SET last_opened_at = ? WHERE id = ?', [timestamp, id])
  }

  /** Deletes the profile and its tag links. Other profiles are not touched. */
  delete(id: string): boolean {
    return this.db.transaction(() => {
      this.db.run('DELETE FROM profile_tags WHERE profile_id = ?', [id])
      this.db.run('DELETE FROM profile_network_status WHERE profile_id = ?', [id])
      this.db.run("DELETE FROM jobs WHERE profile_id = ? AND status = 'pending'", [id])
      return this.db.run('DELETE FROM profiles WHERE id = ?', [id]) > 0
    })
  }

  /** Runs `fn` atomically with any other repository writes it makes. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)
  }
}

function toParams(r: ProfileRecord): (string | number | null)[] {
  return [
    r.id,
    r.name,
    r.notes,
    r.color,
    r.startUrl,
    r.partition,
    r.proxyProtocol,
    r.proxyHost,
    r.proxyPort,
    r.proxyUsername,
    r.proxyPassword,
    r.proxyBypass,
    r.groupId,
    r.browserConfig,
    r.createdAt,
    r.updatedAt,
    r.lastOpenedAt
  ]
}
