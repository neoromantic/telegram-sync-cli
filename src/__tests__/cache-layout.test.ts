/**
 * The move of the shared cache of 0.3 and older to the per-account layout
 * (src/db/cache-layout.ts), on temp data dirs. Every shared cache is
 * written from a child process: a file the test process wrote stays open
 * after close() (see seed-in-child.ts), and tg moves a file only when no
 * process has it open.
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  accountCachePath,
  type CacheLayoutDeps,
  createCacheLayoutGuard,
  foldSharedCache,
  legacyCachePath,
  listSharedCaches,
  migrateSharedCache,
} from '../db/cache-layout'
import { createTestDatabase } from '../db/index'
import { seedInChild } from './helpers/seed-in-child'

/** Rows of the tables that make a shared cache worth keeping */
function rowCounts(path: string): Record<string, number> {
  const db = new Database(path, { readonly: true })
  try {
    const counts: Record<string, number> = {}
    for (const table of ['messages_cache', 'chats_cache', 'users_cache']) {
      counts[table] = (
        db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
      ).n
    }
    return counts
  } finally {
    db.close()
  }
}

/**
 * Every file under the data dir, relative to it, except data.db's and the
 * sidecars of per-account caches that a seeding process left
 */
function filesIn(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((name) => !name.startsWith('data.db'))
    .filter((name) => !/^accounts\/.*-(wal|shm)$/.test(name))
    .filter((name) => !statSync(join(dir, name)).isDirectory())
    .sort()
}

/** An older tg: keeps a file open, idle, until it exits */
function holdOpen(path: string) {
  const holder = Bun.spawn(
    [
      'bun',
      '--no-env-file',
      '-e',
      `
        import { Database } from 'bun:sqlite'
        const db = new Database(process.env.HOLD_PATH)
        db.query('SELECT COUNT(*) FROM chats_cache').get()
        console.log('open')
        for await (const _ of console) break
        db.close()
      `,
    ],
    {
      env: { ...process.env, HOLD_PATH: path },
      stdin: 'pipe',
      stdout: 'pipe',
    },
  )
  return {
    async ready() {
      const decoder = new TextDecoder()
      let text = ''
      for await (const chunk of holder.stdout) {
        text += decoder.decode(chunk, { stream: true })
        if (text.includes('open')) return
      }
      throw new Error('holder exited before it opened the file')
    },
    async release() {
      holder.stdin.write('done\n')
      holder.stdin.end()
      await holder.exited
    },
  }
}

describe('migrateSharedCache', () => {
  let dataDir: string
  let shared: string
  let data: ReturnType<typeof createTestDatabase>
  let notice: ReturnType<typeof mock>

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-cache-layout-'))
    shared = legacyCachePath(dataDir)
    data = createTestDatabase()
    notice = mock(() => {})
  })

  afterEach(() => {
    data.db.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  function addAccounts(count: number) {
    for (let i = 1; i <= count; i++) {
      data.accountsDb.create({ phone: `+1555000000${i}`, is_active: i === 1 })
    }
  }

  function deps(): CacheLayoutDeps {
    return { dataDir, db: data.db, accounts: data.accountsDb, notice }
  }

  /** A per-account cache that a newer run already created */
  function createAccountCache(accountId: number) {
    mkdirSync(join(dataDir, 'accounts', String(accountId)), {
      recursive: true,
    })
    seedInChild(accountCachePath(dataDir, accountId), 'emptyCache')
  }

  it('does nothing without a shared cache', () => {
    addAccounts(1)

    expect(migrateSharedCache(deps())).toEqual({ state: 'none' })
    expect(filesIn(dataDir)).toEqual([])
  })

  describe('decides by the accounts and the per-account caches', () => {
    for (const [accounts, accountCache, empty, state] of [
      [1, false, false, 'adopted'],
      [1, false, true, 'adopted'],
      [1, true, false, 'parked'],
      [1, true, true, 'deleted'],
      [0, false, false, 'parked'],
      [0, false, true, 'deleted'],
      [2, false, false, 'parked'],
      [2, false, true, 'deleted'],
      [2, true, false, 'parked'],
      [2, true, true, 'deleted'],
    ] as const) {
      const label = `${accounts} account(s), ${accountCache ? 'a' : 'no'} per-account cache, ${empty ? 'an empty' : 'a'} shared cache`
      it(`${label}: ${state}`, () => {
        addAccounts(accounts)
        if (accountCache) createAccountCache(1)
        seedInChild(shared, empty ? 'emptyCache' : 'legacySharedCache')
        const before = empty ? null : rowCounts(shared)

        const result = migrateSharedCache(deps())

        expect(result.state).toBe(state)
        expect(existsSync(shared)).toBe(false)
        if (state === 'adopted') {
          expect(result).toMatchObject({
            accountId: 1,
            path: accountCachePath(dataDir, 1),
          })
          expect(filesIn(dataDir)).toEqual(['accounts/1/cache.db'])
          if (before) {
            expect(rowCounts(accountCachePath(dataDir, 1))).toEqual(before)
          }
        }
        if (state === 'parked') {
          const parked = join(dataDir, 'shared-cache.db')
          expect(result.path).toBe(parked)
          expect(rowCounts(parked)).toEqual(before!)
          expect(notice).toHaveBeenCalledTimes(1)
          expect(notice.mock.calls[0]![0]).toContain(parked)
          // Never merged into an account's cache
          if (accountCache) {
            expect(rowCounts(accountCachePath(dataDir, 1))).toEqual({
              messages_cache: 0,
              chats_cache: 0,
              users_cache: 0,
            })
          }
        } else {
          expect(notice).not.toHaveBeenCalled()
        }
        if (state === 'deleted') {
          expect(filesIn(dataDir)).toEqual(
            accountCache ? ['accounts/1/cache.db'] : [],
          )
        }
      })
    }
  })

  it('keeps the rows another process left in the WAL', () => {
    data.accountsDb.create({ phone: '+15550000003' })
    data.accountsDb.create({ phone: '+15550000004' })
    data.accountsDb.delete(1)
    data.accountsDb.delete(2)
    const account = data.accountsDb.create({ phone: '+15550000005' })
    expect(account.id).toBe(3)

    seedInChild(shared, 'cacheWithRowsInWal', { messages: 25 })
    expect(statSync(`${shared}-wal`).size).toBeGreaterThan(0)

    expect(migrateSharedCache(deps())).toMatchObject({
      state: 'adopted',
      accountId: 3,
    })

    const moved = accountCachePath(dataDir, 3)
    expect(rowCounts(moved)).toEqual({
      messages_cache: 25,
      chats_cache: 1,
      users_cache: 0,
    })
    for (const path of [shared, `${shared}-wal`, `${shared}-shm`]) {
      expect(existsSync(path)).toBe(false)
    }
    expect(filesIn(dataDir)).toEqual(['accounts/3/cache.db'])
  })

  it('creates the account directory readable only by its owner', () => {
    addAccounts(1)
    seedInChild(shared, 'legacySharedCache')

    migrateSharedCache(deps())

    expect(statSync(join(dataDir, 'accounts', '1')).mode & 0o777).toBe(0o700)
  })

  it('never overwrites a shared cache set aside earlier', () => {
    addAccounts(2)
    const first = join(dataDir, 'shared-cache.db')
    seedInChild(first, 'legacySharedCache')
    const firstBytes = readFileSync(first)
    seedInChild(shared, 'cacheWithRowsInWal', { messages: 3 })

    const result = migrateSharedCache(deps())

    const second = join(dataDir, 'shared-cache-2.db')
    expect(result).toEqual({ state: 'parked', path: second })
    expect(readFileSync(first).equals(firstBytes)).toBe(true)
    expect(rowCounts(second).messages_cache).toBe(3)
    expect(listSharedCaches(dataDir).map((file) => file.path)).toEqual([
      first,
      second,
    ])
  })

  it('sets a shared cache aside when it appears after the account has one', () => {
    addAccounts(1)
    createAccountCache(1)
    seedInChild(shared, 'cacheWithRowsInWal', { messages: 2 })

    expect(migrateSharedCache(deps())).toMatchObject({ state: 'parked' })
    expect(rowCounts(accountCachePath(dataDir, 1)).messages_cache).toBe(0)
  })

  it('sets aside a file SQLite cannot read, even for a single account', () => {
    addAccounts(1)
    writeFileSync(shared, 'not a database')

    expect(migrateSharedCache(deps())).toMatchObject({ state: 'parked' })
    expect(existsSync(join(dataDir, 'accounts'))).toBe(false)
  })

  describe('while another process has the shared cache open', () => {
    it('blocks the only account, and adopts once the process exits', async () => {
      addAccounts(1)
      seedInChild(shared, 'legacySharedCache')
      const before = rowCounts(shared)
      const holder = holdOpen(shared)
      await holder.ready()

      try {
        expect(migrateSharedCache(deps())).toEqual({
          state: 'blocked',
          reason: 'shared_cache_in_use',
          path: shared,
          accountId: 1,
        })
        expect(existsSync(shared)).toBe(true)
        expect(existsSync(join(dataDir, 'accounts'))).toBe(false)
      } finally {
        await holder.release()
      }

      expect(migrateSharedCache(deps()).state).toBe('adopted')
      expect(rowCounts(accountCachePath(dataDir, 1))).toEqual(before)
    }, 20_000)

    it('defers setting it aside', async () => {
      addAccounts(2)
      seedInChild(shared, 'legacySharedCache')
      const holder = holdOpen(shared)
      await holder.ready()

      try {
        expect(migrateSharedCache(deps())).toEqual({
          state: 'deferred',
          reason: 'shared_cache_in_use',
          path: shared,
        })
        expect(existsSync(shared)).toBe(true)
      } finally {
        await holder.release()
      }

      expect(migrateSharedCache(deps()).state).toBe('parked')
    }, 20_000)
  })

  it('leaves data.db unlocked and its busy_timeout as it was', () => {
    addAccounts(1)
    data.db.run('PRAGMA busy_timeout = 1234')
    seedInChild(shared, 'legacySharedCache')

    migrateSharedCache(deps())

    expect(data.db.query('PRAGMA busy_timeout').get()).toEqual({
      timeout: 1234,
    })
    expect(data.db.inTransaction).toBe(false)
  })
})

describe('foldSharedCache', () => {
  it('never creates a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-cache-fold-'))
    try {
      const path = join(dir, 'cache.db')
      expect(foldSharedCache(path)).toEqual({ state: 'unreadable' })
      expect(existsSync(path)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('createCacheLayoutGuard', () => {
  let dataDir: string
  let data: ReturnType<typeof createTestDatabase>

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-cache-guard-'))
    data = createTestDatabase()
    data.accountsDb.create({ phone: '+15550000001', is_active: true })
  })

  afterEach(() => {
    data.db.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const guard = () =>
    createCacheLayoutGuard(() => ({
      dataDir,
      db: data.db,
      accounts: data.accountsDb,
    }))

  it('checks once per process after a move', () => {
    const layout = guard()
    seedInChild(legacyCachePath(dataDir), 'legacySharedCache')

    expect(layout.ensure('strict').state).toBe('adopted')
    // A file an older tg writes later waits for the next process
    seedInChild(legacyCachePath(dataDir), 'emptyCache')
    expect(layout.ensure('strict').state).toBe('adopted')
    expect(existsSync(legacyCachePath(dataDir))).toBe(true)
  })

  it('throws CACHE_UNAVAILABLE in strict mode and reports in report mode while blocked', async () => {
    const layout = guard()
    const shared = legacyCachePath(dataDir)
    seedInChild(shared, 'legacySharedCache')
    const holder = holdOpen(shared)
    await holder.ready()

    try {
      expect(() => layout.ensure('strict')).toThrow(
        expect.objectContaining({ reason: 'shared_cache_in_use' }),
      )
      expect(layout.ensure('report')).toMatchObject({
        state: 'blocked',
        reason: 'shared_cache_in_use',
      })
    } finally {
      await holder.release()
    }

    // Blocked is not remembered: the next call moves it
    expect(layout.ensure('strict').state).toBe('adopted')
  }, 20_000)
})
