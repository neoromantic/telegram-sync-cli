import { defineCommand, runCommand } from 'citty'

import { getCacheDb } from '../../db'
import { getTableNames } from '../../db/schema-annotations'
import { ErrorCodes } from '../../types'
import { stringify as stringifyCsv } from '../../utils/csv'
import { error, success } from '../../utils/output'
import { applyQueryLimit, isReadOnlyQuery } from './helpers'
import { printSchemaCommand } from './print-schema'

type QueryArgs = {
  command?: string
  query?: string
  output?: string
  limit?: string
  _?: string[]
}

function parseQueryArgs(args: QueryArgs) {
  const positionalArgs = args._ ?? []
  const query = (args.query ?? positionalArgs.join(' ')) || undefined
  const output = args.output ?? 'json'
  const limitStr = args.limit ?? '1000'
  const limit = Number.parseInt(limitStr, 10)

  return { query, output, limit, limitStr }
}

function validateQueryArgs(
  query: string | undefined,
  output: string,
  limit: number,
  limitStr: string,
): void {
  if (!query) {
    error(
      ErrorCodes.INVALID_ARGS,
      'No query provided. Usage: tg sql -q "<query>" or tg sql print-schema',
    )
  }

  if (output !== 'json' && output !== 'csv') {
    error(
      ErrorCodes.INVALID_ARGS,
      `Invalid output: ${output}. Use 'json' or 'csv'.`,
    )
  }

  if (Number.isNaN(limit) || limit < 0) {
    error(
      ErrorCodes.INVALID_ARGS,
      `Invalid limit: ${limitStr}. Use a non-negative integer.`,
    )
  }

  if (!isReadOnlyQuery(query)) {
    error(
      ErrorCodes.SQL_WRITE_NOT_ALLOWED,
      'Write operations are not allowed. Only SELECT queries are permitted.',
      { query },
    )
  }
}

function formatSqlError(message: string, query: string): never {
  if (message.includes('no such table')) {
    const match = message.match(/no such table: (\w+)/)
    const tableName = match?.[1] ?? 'unknown'
    const available = getTableNames().join(', ')
    error(
      ErrorCodes.SQL_TABLE_NOT_FOUND,
      `Table '${tableName}' not found. Available tables: ${available}`,
      { query },
    )
  }

  if (message.includes('syntax error') || message.includes('near "')) {
    error(ErrorCodes.SQL_SYNTAX_ERROR, message, { query })
  }

  error(ErrorCodes.GENERAL_ERROR, `Query failed: ${message}`, { query })
}

export const sqlQueryCommand = defineCommand({
  meta: {
    name: 'sql',
    description: 'Execute read-only SQL queries on the cache database',
  },
  args: {
    command: {
      type: 'positional',
      description: 'Optional subcommand (print-schema)',
    },
    query: {
      type: 'string',
      alias: 'q',
      description: 'SQL query to execute (required unless using a subcommand)',
    },
    output: {
      type: 'enum',
      alias: 'o',
      description: 'Output format: json or csv',
      options: ['json', 'csv'],
      default: 'json',
    },
    limit: {
      type: 'string',
      alias: 'l',
      description: 'Maximum rows to return (default: 1000, 0 = unlimited)',
      default: '1000',
    },
  },
  async run({ args, rawArgs }) {
    const sqlArgs = args as QueryArgs
    const positionalArgs = sqlArgs._ ?? []
    const command =
      typeof sqlArgs.command === 'string' ? sqlArgs.command : positionalArgs[0]

    if (command === 'print-schema') {
      if (sqlArgs.query) {
        error(
          ErrorCodes.INVALID_ARGS,
          'print-schema does not accept --query. Use tg sql print-schema [--table=...]',
        )
      }

      const idx = rawArgs?.indexOf('print-schema') ?? -1
      const remainingArgs =
        idx >= 0 ? rawArgs.slice(idx + 1) : (rawArgs?.slice(1) ?? [])
      await runCommand(printSchemaCommand, { rawArgs: remainingArgs })
      return
    }

    if (sqlArgs.query && positionalArgs.length > 0) {
      error(
        ErrorCodes.INVALID_ARGS,
        'Unexpected extra arguments. Wrap SQL in quotes or pass only --query.',
      )
    }

    const { query, output, limit, limitStr } = parseQueryArgs(sqlArgs)
    validateQueryArgs(query, output, limit, limitStr)

    try {
      const db = getCacheDb()
      const finalQuery = applyQueryLimit(query!, limit)
      const rows = db.query(finalQuery).all() as Record<string, unknown>[]
      const columns = rows.length > 0 ? Object.keys(rows[0]!) : []

      if (output === 'csv') {
        const csv = stringifyCsv(rows, columns)
        console.log(csv)
        return
      }

      success({
        columns,
        rows,
        rowCount: rows.length,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      formatSqlError(message, query!)
    }
  },
})
