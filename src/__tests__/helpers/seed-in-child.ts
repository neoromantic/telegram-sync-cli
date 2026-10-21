/**
 * Write a SQLite file from a child process. Caches and services keep
 * prepared statements, and bun:sqlite closes a connection only once they
 * are finalized, so a file written in the test process stays open after
 * close(). tg moves a shared cache only when no process has it open, so it
 * would find every such file in use.
 */
import { join } from 'node:path'

const SEED_SCRIPT = `
  import { Database } from 'bun:sqlite'
  const db = new Database(process.env.SEED_PATH)
  const mod = await import(process.env.SEED_MODULE)
  const result = await mod[process.env.SEED_EXPORT](
    db,
    JSON.parse(process.env.SEED_ARGS),
  )
  console.log('seeded')
  // Bun closes open databases at exit, which checkpoints the WAL: a seeder
  // that leaves rows in the WAL ends the process without an exit
  if (result === 'exit-without-close') process.kill(process.pid, 'SIGKILL')
  db.close()
  process.exit(0)
`

/** Seeders this helper can run, by name: exports of seeders.ts */
export type Seeder = keyof typeof import('./seeders')

export function seedInChild(
  path: string,
  seeder: Seeder,
  args: unknown = null,
): void {
  const result = Bun.spawnSync(['bun', '--no-env-file', '-e', SEED_SCRIPT], {
    env: {
      ...process.env,
      SEED_PATH: path,
      SEED_MODULE: join(import.meta.dir, 'seeders.ts'),
      SEED_EXPORT: seeder,
      SEED_ARGS: JSON.stringify(args),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (!result.stdout.toString().includes('seeded')) {
    throw new Error(
      `Seeding ${path} with ${seeder} failed: ${result.stderr.toString()}`,
    )
  }
}
