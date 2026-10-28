import type { Database } from 'bun:sqlite'

import type { TableAnnotation } from '../../db/schema-annotations'

function formatHeader(
  tableName: string,
  annotation: TableAnnotation,
): string[] {
  const lines: string[] = []
  lines.push(`Table: ${tableName}`)
  lines.push(`Description: ${annotation.description}`)
  if (annotation.ttl) {
    lines.push(`TTL: ${annotation.ttl}`)
  }
  const pk = Array.isArray(annotation.primaryKey)
    ? annotation.primaryKey.join(', ')
    : annotation.primaryKey
  lines.push(`Primary Key: ${pk}`)
  lines.push('')
  return lines
}

function formatColumnFlags(
  colName: string,
  annotation: TableAnnotation,
): string {
  const flags: string[] = []
  const pk = annotation.primaryKey
  const isPrimaryKey = Array.isArray(pk) ? pk.includes(colName) : pk === colName
  if (isPrimaryKey) {
    flags.push('PK')
  }
  if (annotation.columns[colName]?.nullable === false) {
    flags.push('NN')
  }
  const defaultValue = annotation.columns[colName]?.defaultValue
  if (defaultValue !== undefined) {
    flags.push(`=${defaultValue}`)
  }

  return flags.length > 0 ? `  [${flags.join(', ')}]` : ''
}

function formatColumnDetails(
  colName: string,
  annotation: TableAnnotation,
): string[] {
  const col = annotation.columns[colName]
  if (!col) return []

  const lines: string[] = []
  lines.push(`    ${col.description}`)
  if (col.enumValues) {
    lines.push(`    Values: ${col.enumValues.join(', ')}`)
  }
  if (col.semanticType) {
    lines.push(`    Type: ${col.semanticType}`)
  }
  return lines
}

function formatColumns(annotation: TableAnnotation): string[] {
  const lines: string[] = []
  lines.push('Columns:')

  for (const colName of Object.keys(annotation.columns)) {
    const flagStr = formatColumnFlags(colName, annotation)
    lines.push(`  ${colName}${flagStr}`)
    lines.push(...formatColumnDetails(colName, annotation))
  }

  return lines
}

function formatIndexes(annotation: TableAnnotation): string[] {
  if (!annotation.indexes || Object.keys(annotation.indexes).length === 0) {
    return []
  }

  const lines: string[] = []
  lines.push('')
  lines.push('Indexes:')
  for (const [indexName, desc] of Object.entries(annotation.indexes)) {
    lines.push(`  ${indexName}: ${desc}`)
  }
  return lines
}

export function formatSchemaAsText(
  tableName: string,
  annotation: TableAnnotation,
): string {
  const lines: string[] = []
  lines.push(...formatHeader(tableName, annotation))
  lines.push(...formatColumns(annotation))
  lines.push(...formatIndexes(annotation))
  return lines.join('\n')
}

// =============================================================================
// SQL Format Output
// =============================================================================

interface ColumnInfo {
  name: string
  type: string
  notnull: number
  pk: number
  dflt_value: unknown
}

interface IndexInfo {
  name: string
  unique: number
  origin: string
  partial: number
  sql?: string
}

interface IndexColumnInfo {
  seqno: number
  cid: number
  name: string
}

/**
 * Build a comment string for a column based on its annotation
 */
function buildColumnComment(
  colName: string,
  annotation: TableAnnotation,
): string {
  const col = annotation.columns[colName]
  if (!col) return ''

  const parts: string[] = []

  // Main description
  parts.push(col.description)

  // Semantic type hint
  if (col.semanticType) {
    parts.push(`[${col.semanticType}]`)
  }

  // Enum values
  if (col.enumValues && col.enumValues.length > 0) {
    parts.push(`Values: ${col.enumValues.join(' | ')}`)
  }

  return parts.join(' ')
}

/**
 * Format a single column definition with inline comment
 */
function formatSqlColumn(
  col: ColumnInfo,
  annotation: TableAnnotation,
  isLast: boolean,
  primaryKeyColumns: string[],
): string {
  const parts: string[] = []

  // Column name and type
  parts.push(`  ${col.name.padEnd(20)} ${col.type.padEnd(12)}`)

  // NOT NULL constraint (skip for PK columns, it's implied)
  if (col.notnull === 1 && col.pk === 0) {
    parts.push('NOT NULL')
  }

  // Default value
  if (col.dflt_value !== null && col.dflt_value !== undefined) {
    parts.push(`DEFAULT ${col.dflt_value}`)
  }

  // PRIMARY KEY for single-column PK
  if (col.pk > 0 && primaryKeyColumns.length === 1) {
    parts.push('PRIMARY KEY')
  }

  // Trailing comma or nothing
  const suffix = isLast ? '' : ','

  // Build the definition line
  const definition = parts.join(' ') + suffix

  // Add comment
  const comment = buildColumnComment(col.name, annotation)
  if (comment) {
    const padding = Math.max(1, 80 - definition.length)
    return `${definition}${' '.repeat(padding)}-- ${comment}`
  }

  return definition
}

/**
 * Format CREATE TABLE statement with comments
 */
function formatCreateTable(
  tableName: string,
  columns: ColumnInfo[],
  annotation: TableAnnotation,
  kind: 'TABLE' | 'VIEW',
): string[] {
  const lines: string[] = []

  // Table header comment
  lines.push(`-- ${annotation.description}`)
  if (annotation.ttl) {
    lines.push(`-- TTL: ${annotation.ttl}`)
  }
  lines.push(`CREATE ${kind} ${tableName} (`)

  // Determine primary key columns
  const pkCols = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk)
  const primaryKeyColumns = pkCols.map((c) => c.name)
  const hasCompositePK = primaryKeyColumns.length > 1

  // Format columns
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i]
    const isLast = i === columns.length - 1 && !hasCompositePK
    lines.push(formatSqlColumn(col!, annotation, isLast, primaryKeyColumns))
  }

  // Add composite PRIMARY KEY constraint
  if (hasCompositePK) {
    lines.push(`  PRIMARY KEY (${primaryKeyColumns.join(', ')})`)
  }

  lines.push(');')
  return lines
}

/**
 * Format CREATE INDEX statements with comments
 */
function formatCreateIndexes(
  tableName: string,
  db: Database,
  annotation: TableAnnotation,
): string[] {
  const lines: string[] = []

  const indexList = db
    .query(`PRAGMA index_list(${tableName})`)
    .all() as IndexInfo[]

  for (const idx of indexList) {
    // Skip auto-indexes (created implicitly by SQLite)
    if (idx.origin === 'pk') continue

    // Get index columns
    const indexCols = db
      .query(`PRAGMA index_info(${idx.name})`)
      .all() as IndexColumnInfo[]
    const colNames = indexCols
      .sort((a, b) => a.seqno - b.seqno)
      .map((c) => c.name)

    // Try to get the original CREATE INDEX statement
    const sqlResult = db
      .query(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get(idx.name) as { sql: string | null } | null

    if (sqlResult?.sql) {
      // Add description comment if available
      const desc = annotation.indexes?.[idx.name]
      if (desc) {
        lines.push(`-- ${desc}`)
      } else {
        lines.push(`-- Index on (${colNames.join(', ')})`)
      }
      lines.push(`${sqlResult.sql};`)
      lines.push('')
    }
  }

  return lines
}

/**
 * Format full schema as annotated SQL DDL
 */
export function formatSchemaAsSql(
  tableName: string,
  annotation: TableAnnotation,
  db: Database,
): string {
  const lines: string[] = []

  // Get column info from database
  const columns = db
    .query(`PRAGMA table_info(${tableName})`)
    .all() as ColumnInfo[]

  const view = db
    .query(`SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = ?`)
    .get(tableName)

  // Format CREATE TABLE, or CREATE VIEW with the view's columns
  lines.push(
    ...formatCreateTable(
      tableName,
      columns,
      annotation,
      view ? 'VIEW' : 'TABLE',
    ),
  )
  lines.push('')

  // Format indexes
  const indexLines = formatCreateIndexes(tableName, db, annotation)
  if (indexLines.length > 0) {
    lines.push(...indexLines)
  }

  return lines.join('\n')
}
