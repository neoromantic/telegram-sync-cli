import { defineCommand } from 'citty'

import { getCacheDb } from '../../db'
import {
  getColumnNames,
  getTableAnnotation,
  getTableNames,
  SCHEMA_REGISTRY,
} from '../../db/schema-annotations'
import { ErrorCodes } from '../../types'
import { error, success } from '../../utils/output'
import { formatSchemaAsSql, formatSchemaAsText } from './schema-text'

const SUPPORTED_OUTPUTS = ['json', 'text', 'sql'] as const

function readTableInfo(db: ReturnType<typeof getCacheDb>, tableName: string) {
  return db.query(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string
    type: string
    notnull: number
    pk: number
    dflt_value: unknown
  }>
}

function readIndexInfo(db: ReturnType<typeof getCacheDb>, tableName: string) {
  const indexList = db.query(`PRAGMA index_list(${tableName})`).all() as Array<{
    name: string
    unique: number
  }>

  return indexList.map((idx) => {
    const indexInfo = db
      .query(`PRAGMA index_info(${idx.name})`)
      .all() as Array<{ name: string }>
    return {
      name: idx.name,
      columns: indexInfo.map((i) => i.name),
      unique: idx.unique === 1,
    }
  })
}

function handleSingleTable(tableName: string, format: string): void {
  const annotation = getTableAnnotation(tableName)
  if (!annotation) {
    const available = getTableNames().join(', ')
    error(
      ErrorCodes.SQL_TABLE_NOT_FOUND,
      `Table '${tableName}' not found. Available tables: ${available}`,
    )
  }

  const db = getCacheDb()

  if (format === 'text') {
    console.log(formatSchemaAsText(tableName, annotation))
    return
  }

  if (format === 'sql') {
    console.log(formatSchemaAsSql(tableName, annotation, db))
    return
  }

  const tableInfo = readTableInfo(db, tableName)
  const columns = tableInfo.map((col) => {
    const colAnnotation = annotation.columns[col.name]
    return {
      name: col.name,
      type: col.type,
      nullable: col.notnull === 0,
      primaryKey: col.pk > 0,
      defaultValue: col.dflt_value,
      description: colAnnotation?.description ?? '',
      semanticType: colAnnotation?.semanticType,
      enumValues: colAnnotation?.enumValues,
    }
  })

  const indexes = readIndexInfo(db, tableName).map((idx) => ({
    name: idx.name,
    columns: idx.columns,
    description: annotation.indexes?.[idx.name],
  }))

  success({
    table: tableName,
    description: annotation.description,
    ttl: annotation.ttl,
    primaryKey: annotation.primaryKey,
    columns,
    indexes,
  })
}

function handleAllTables(format: string): void {
  if (format === 'text') {
    const tableNames = getTableNames()
    for (const name of tableNames) {
      const annotation = getTableAnnotation(name)
      if (annotation) {
        console.log(formatSchemaAsText(name, annotation))
        console.log(`\n${'='.repeat(80)}\n`)
      }
    }
    return
  }

  if (format === 'sql') {
    const db = getCacheDb()
    const tableNames = getTableNames()
    for (const name of tableNames) {
      const annotation = getTableAnnotation(name)
      if (annotation) {
        console.log(formatSchemaAsSql(name, annotation, db))
        console.log(`\n${'-- '.repeat(27)}\n`)
      }
    }
    return
  }

  success({
    version: SCHEMA_REGISTRY.version,
    tables: Object.keys(SCHEMA_REGISTRY.tables).map((name) => {
      const table = SCHEMA_REGISTRY.tables[name]!
      return {
        name,
        description: table.description,
        ttl: table.ttl,
        primaryKey: table.primaryKey,
        columnCount: getColumnNames(name).length,
      }
    }),
  })
}

export const printSchemaCommand = defineCommand({
  meta: {
    name: 'print-schema',
    description: 'Display database schema with annotations',
  },
  args: {
    table: {
      type: 'string',
      alias: 't',
      description: 'Show schema for specific table only',
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Output format: json, text, sql (default: json)',
      default: 'json',
    },
  },
  async run({ args }) {
    const output = args.output ?? 'json'
    const tableName = args.table

    if (
      !SUPPORTED_OUTPUTS.includes(output as (typeof SUPPORTED_OUTPUTS)[number])
    ) {
      error(
        ErrorCodes.INVALID_ARGS,
        `Invalid output: ${output}. Use 'json', 'text', or 'sql'.`,
      )
    }

    if (tableName) {
      handleSingleTable(tableName, output)
      return
    }

    handleAllTables(output)
  },
})
