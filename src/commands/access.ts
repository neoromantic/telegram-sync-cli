/**
 * Read-only mode and the chat allowlist (`readOnly`, `allowedChats`): what
 * each command does on Telegram and which chats it names, in one table that
 * covers every command, and the checks that run before a command does.
 * They guard against mistakes, not against a process that wants around
 * them: anything with a shell can edit config.json or open the cache.
 */
import { type AccessSettings, ConfigError, loadAccessSettings } from '../config'
import { ErrorCodes } from '../types'
import { openAccountCache } from '../utils/account-cache'
import { positionalChat } from '../utils/args'
import { error } from '../utils/output'
import { openHistory, reportHistoryError } from './messages/helpers'
import { resolveHistoryChatId } from './messages/history'

type Args = Record<string, unknown>

export interface CommandAccess {
  /** Changes something on Telegram's side: refused in read-only mode */
  write?: boolean | ((args: Args) => boolean)
  /** The args that name a chat: a chat outside allowedChats is refused */
  chatArgs?: string[]
  /** Reads across chats: the command itself lists only allowed chats (allowedChatIds) */
  crossChat?: boolean
  /** Reads any chat and can't be limited to some: refused while allowedChats is set */
  unscopable?: boolean
}

/** `tg api` methods named get…, search…, resolve… or check… after the namespace */
export function isReadMethod(method: string): boolean {
  const dot = method.indexOf('.')
  return dot > 0 && /^(get|search|resolve|check)/.test(method.slice(dot + 1))
}

/** Reads only the cache or local files, or Telegram without naming a chat */
const LOCAL: CommandAccess = {}
/** A read of the chat named by --chat */
const CHAT: CommandAccess = { chatArgs: ['chat'] }

/**
 * Every command of the tree (src/cli.ts), by its path. A command that is
 * missing here fails at start (guardCommands) and in access.test.ts.
 * Contacts, `tg user` and `tg me` read people, not chats, so allowedChats
 * doesn't limit them; `tg status` shows counts and chat IDs, no titles or
 * messages.
 */
export const COMMAND_ACCESS: Record<string, CommandAccess> = {
  // A login signs a new session in on Telegram, logout ends one
  'auth login': { write: true },
  'auth login-qr': { write: true },
  'auth logout': { write: true },
  'auth status': LOCAL,
  'accounts list': LOCAL,
  'accounts switch': LOCAL,
  'accounts remove': LOCAL,
  'accounts info': LOCAL,
  'contacts list': LOCAL,
  'contacts search': LOCAL,
  'contacts get': LOCAL,
  'config get': LOCAL,
  'config set': LOCAL,
  'config path': LOCAL,
  'chats list': { crossChat: true },
  'chats search': { crossChat: true },
  'chats get': { chatArgs: ['id'] },
  'chats sync': CHAT,
  send: { write: true, chatArgs: ['to'] },
  'daemon start': LOCAL,
  'daemon stop': LOCAL,
  'daemon status': LOCAL,
  'db vacuum': LOCAL,
  'db migrate': LOCAL,
  'messages list': CHAT,
  'messages get': CHAT,
  'messages search': { chatArgs: ['chat'], crossChat: true },
  // Without --chat, wait, watch and unread read every chat: they keep to allowedChats
  'messages wait': { chatArgs: ['chat'], crossChat: true },
  'messages watch': { chatArgs: ['chat'], crossChat: true },
  'messages unread': { chatArgs: ['chat'], crossChat: true },
  // Marks the chat read on Telegram
  'messages read': { write: true, chatArgs: ['chat'] },
  'media download': CHAT,
  'media clean': LOCAL,
  api: {
    write: (args) => !isReadMethod(String(args.method ?? '')),
    unscopable: true,
  },
  me: LOCAL,
  user: LOCAL,
  status: LOCAL,
  'skill manifest': LOCAL,
  'skill validate': LOCAL,
  'skill install': LOCAL,
  sql: { unscopable: true },
  'telemetry status': LOCAL,
  'telemetry on': LOCAL,
  'telemetry off': LOCAL,
}

/** The parts of a citty command that the walk reads */
interface CommandNode {
  args?: unknown
  subCommands?: unknown
  run?: unknown
}

/** What citty passes a command's run */
export interface RunContext {
  args: Args
  rawArgs?: string[]
}

type Run = (context: RunContext) => unknown

/** Every command of the tree that runs, with its path (`chats list`) */
export function runnableCommands(
  cmd: CommandNode,
  prefix: string[] = [],
): Array<{ path: string; node: CommandNode }> {
  const subs = (cmd.subCommands ?? {}) as Record<string, CommandNode>
  return Object.entries(subs).flatMap(([name, sub]) => {
    const path = [...prefix, name]
    const own =
      typeof sub.run === 'function' ? [{ path: path.join(' '), node: sub }] : []
    return [...own, ...runnableCommands(sub, path)]
  })
}

/** Wrap every command's run so the checks of its COMMAND_ACCESS entry come first */
export function guardCommands(cmd: CommandNode): void {
  for (const { path, node } of runnableCommands(cmd)) {
    const access = COMMAND_ACCESS[path]
    if (!access) {
      throw new Error(`tg ${path} has no entry in COMMAND_ACCESS`)
    }
    const run = node.run as Run
    const defs = (node.args ?? {}) as Record<string, { type?: string }>
    const positional = Object.keys(defs).filter(
      (name) => defs[name]?.type === 'positional',
    )
    node.run = async (context: RunContext) => {
      await checkAccess(path, access, context, positional)
      return run(context)
    }
  }
}

/** readOnly and allowedChats; INVALID_ARGS for a bad value */
async function readAccessSettings(): Promise<AccessSettings> {
  try {
    return await loadAccessSettings()
  } catch (err) {
    if (err instanceof ConfigError) {
      error(ErrorCodes.INVALID_ARGS, err.message, { issues: err.issues })
    }
    throw err
  }
}

const READ_ONLY_SUGGESTION =
  'Read-only mode allows only reads. readOnly in config.json or TELEGRAM_SYNC_CLI_READ_ONLY turns it on; tg status shows it'

/**
 * Refuse the command before it runs: READ_ONLY for a write in read-only
 * mode, CHAT_NOT_ALLOWED for a chat outside allowedChats or for a command
 * that can't be limited to chats while the list is set
 */
export async function checkAccess(
  path: string,
  access: CommandAccess,
  { args, rawArgs = [] }: RunContext,
  positional: string[] = [],
): Promise<void> {
  if (!access.write && !access.chatArgs && !access.unscopable) return
  const settings = await readAccessSettings()

  const write =
    typeof access.write === 'function' ? access.write(args) : access.write
  if (write && settings.readOnly) {
    const method = path === 'api' ? String(args.method ?? '') : null
    error(
      ErrorCodes.READ_ONLY,
      method === null
        ? `Read-only mode is on, and tg ${path} changes Telegram`
        : `Read-only mode is on, and ${method} is not a read method (get…, search…, resolve…, check…)`,
      { command: path, ...(method !== null && { method }) },
      READ_ONLY_SUGGESTION,
    )
  }

  const allowed = settings.allowedChats
  if (allowed === null) return
  if (access.unscopable) {
    error(
      ErrorCodes.CHAT_NOT_ALLOWED,
      `tg ${path} can't be limited to the chats in allowedChats, so it is off while allowedChats is set`,
      { command: path },
      'Use tg chats, tg messages and tg media, which keep to allowedChats',
    )
  }
  for (const name of access.chatArgs ?? []) {
    // A positional chat as the command reads it
    const input = positional.includes(name)
      ? positionalChat(args[name], rawArgs)
      : args[name]
    if (typeof input === 'string' && input.trim() !== '') {
      await checkChatAllowed(input, args.account as string | undefined, allowed)
    }
  }
}

type HistoryDeps = ReturnType<typeof openHistory>

/**
 * The marked IDs of the list: an ID as given, @username and me as
 * `tg messages list --chat` resolves them (a cached username needs no
 * connection; me is the account's own user ID)
 */
async function resolveAllowed(
  entries: string[],
  deps: HistoryDeps,
): Promise<Set<number>> {
  const ids = new Set<number>()
  for (const entry of entries) {
    ids.add(
      /^-?\d+$/.test(entry)
        ? Number(entry)
        : await resolveHistoryChatId(deps.client, entry, deps),
    )
  }
  return ids
}

const ALLOWED_SUGGESTION =
  'Only the chats in allowedChats (config.json or TELEGRAM_SYNC_CLI_ALLOWED_CHATS) can be used; tg status lists them'

/** CHAT_NOT_ALLOWED unless the chat resolves to an ID of the list */
async function checkChatAllowed(
  input: string,
  accountSelector: string | undefined,
  allowed: string[],
): Promise<void> {
  const { account } = openAccountCache(accountSelector)
  const deps = openHistory(account.id, 'cli:allowed-chats')
  let id: number
  let ids: Set<number>
  try {
    id = await resolveHistoryChatId(deps.client, input, deps)
    ids = await resolveAllowed(allowed, deps)
  } catch (err) {
    reportHistoryError(err, `check ${input} against allowedChats`)
  }
  if (!ids.has(id)) {
    error(
      ErrorCodes.CHAT_NOT_ALLOWED,
      `Chat ${input} is not in allowedChats`,
      { chat: input, id },
      ALLOWED_SUGGESTION,
    )
  }
}

/**
 * For a command that reads across chats: the marked IDs of allowedChats,
 * or null when every chat is allowed
 */
export async function allowedChatIds(
  accountId: number,
): Promise<Set<number> | null> {
  const { allowedChats } = await readAccessSettings()
  if (allowedChats === null) return null
  const deps = openHistory(accountId, 'cli:allowed-chats')
  try {
    return await resolveAllowed(allowedChats, deps)
  } catch (err) {
    reportHistoryError(err, 'resolve allowedChats')
  }
}
