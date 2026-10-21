import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const INTEGRATION_TEST_BASE = join(
  tmpdir(),
  'telegram-sync-cli-integration-tests',
)

export interface IntegrationEnvironment {
  dataDir: string
  accountId: number
  initFromSession(options: {
    phone: string
    sessionPath: string
    accountId?: number
    userId?: number | null
    name?: string | null
    username?: string | null
  }): Promise<void>
  /** The account's cache, `accounts/<id>/cache.db`; tg creates it */
  cachePath(accountId?: number): string
  cleanup(): void
  getCliOptions(extraEnv?: Record<string, string>): {
    env: Record<string, string>
  }
}

function initSchema(db: Database): void {
  db.run('PRAGMA journal_mode = WAL')

  db.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      user_id INTEGER,
      name TEXT,
      username TEXT,
      label TEXT,
      session_data TEXT NOT NULL DEFAULT '',
      is_active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `)

  db.run('CREATE INDEX IF NOT EXISTS idx_accounts_phone ON accounts(phone)')
  db.run(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id)',
  )
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username)',
  )
  db.run('CREATE INDEX IF NOT EXISTS idx_accounts_label ON accounts(label)')
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts(is_active)',
  )
}

async function copyFileIfExists(source: string, destination: string) {
  const file = Bun.file(source)
  if (!(await file.exists())) {
    return false
  }
  await Bun.write(destination, file)
  return true
}

async function copySessionFiles(
  sourceBase: string,
  destinationBase: string,
): Promise<void> {
  const copiedMain = await copyFileIfExists(sourceBase, destinationBase)
  if (!copiedMain) {
    throw new Error(`Session file not found: ${sourceBase}`)
  }

  await copyFileIfExists(`${sourceBase}-wal`, `${destinationBase}-wal`)
  await copyFileIfExists(`${sourceBase}-shm`, `${destinationBase}-shm`)
}

export function createIntegrationEnvironment(
  testName: string,
): IntegrationEnvironment {
  const timestamp = Date.now()
  const randomSuffix = Math.random().toString(36).substring(2, 8)
  const dataDir = join(
    INTEGRATION_TEST_BASE,
    `${testName}-${timestamp}-${randomSuffix}`,
  )

  mkdirSync(dataDir, { recursive: true })

  let activeAccountId = 1

  return {
    dataDir,
    get accountId() {
      return activeAccountId
    },
    async initFromSession(options) {
      const accountId = options.accountId ?? 1
      activeAccountId = accountId

      const dbPath = join(dataDir, 'data.db')
      const db = new Database(dbPath)
      initSchema(db)

      const username = options.username?.startsWith('@')
        ? options.username.slice(1)
        : (options.username ?? null)

      const stmt = db.prepare(`
        INSERT INTO accounts (
          id,
          phone,
          user_id,
          name,
          username,
          label,
          session_data,
          is_active
        )
        VALUES (
          $id,
          $phone,
          $user_id,
          $name,
          $username,
          $label,
          $session_data,
          $is_active
        )
      `)
      stmt.run({
        $id: accountId,
        $phone: options.phone,
        $user_id: options.userId ?? null,
        $name: options.name ?? null,
        $username: username,
        $label: null,
        $session_data: '',
        $is_active: 1,
      })

      db.close()

      await copySessionFiles(
        options.sessionPath,
        join(dataDir, `session_${accountId}.db`),
      )
    },
    cachePath(accountId = activeAccountId) {
      return join(dataDir, 'accounts', String(accountId), 'cache.db')
    },
    cleanup() {
      if (existsSync(dataDir)) {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
    getCliOptions(extraEnv: Record<string, string> = {}) {
      return {
        env: {
          TELEGRAM_SYNC_CLI_DATA_DIR: dataDir,
          ...extraEnv,
        },
      }
    },
  }
}
