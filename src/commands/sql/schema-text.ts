import type { Database } from "bun:sqlite";

import type { TableAnnotation } from "../../db/schema-annotations";

function formatHeader(tableName: string, annotation: TableAnnotation) {
  const lines: string[] = [];
  lines.push(`Table: ${tableName}`);
  lines.push(`Description: ${annotation.description}`);
  if (annotation.ttl) {
    lines.push(`TTL: ${annotation.ttl}`);
  }
  const pk = Array.isArray(annotation.primaryKey)
    ? annotation.primaryKey.join(", ")
    : annotation.primaryKey;
  lines.push(`Primary Key: ${pk}`);
  lines.push("");
  return lines;
}

function formatColumnFlags(colName: string, annotation: TableAnnotation) {
  const flags: string[] = [];
  const pk = annotation.primaryKey;
  const isPrimaryKey = Array.isArray(pk) ? pk.includes(colName) : pk === colName;
  if (isPrimaryKey) {
    flags.push("PK");
  }
  if (annotation.columns[colName]?.nullable === false) {
    flags.push("NN");
  }
  const defaultValue = annotation.columns[colName]?.defaultValue;
  if (defaultValue !== undefined) {
    flags.push(`=${defaultValue}`);
  }

  return flags.length > 0 ? `  [${flags.join(", ")}]` : "";
}

function formatColumnDetails(colName: string, annotation: TableAnnotation) {
  const col = annotation.columns[colName];
  if (!col) return [];

  const lines: string[] = [];
  lines.push(`    ${col.description}`);
  if (col.enumValues) {
    lines.push(`    Values: ${col.enumValues.join(", ")}`);
  }
  if (col.semanticType) {
    lines.push(`    Type: ${col.semanticType}`);
  }
  return lines;
}

function formatColumns(annotation: TableAnnotation) {
  const lines: string[] = [];
  lines.push("Columns:");

  for (const colName of Object.keys(annotation.columns)) {
    const flagStr = formatColumnFlags(colName, annotation);
    lines.push(`  ${colName}${flagStr}`);
    lines.push(...formatColumnDetails(colName, annotation));
  }

  return lines;
}

function formatIndexes(annotation: TableAnnotation) {
  if (!annotation.indexes || Object.keys(annotation.indexes).length === 0) {
    return [];
  }

  const lines: string[] = [];
  lines.push("");
  lines.push("Indexes:");
  for (const [indexName, desc] of Object.entries(annotation.indexes)) {
    lines.push(`  ${indexName}: ${desc}`);
  }
  return lines;
}

export function formatSchemaAsText(tableName: string, annotation: TableAnnotation) {
  const lines: string[] = [];
  lines.push(...formatHeader(tableName, annotation));
  lines.push(...formatColumns(annotation));
  lines.push(...formatIndexes(annotation));
  return lines.join("\n");
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: unknown;
}

interface IndexInfo {
  name: string;
  unique: number;
  origin: string;
  partial: number;
  sql?: string;
}

interface IndexColumnInfo {
  seqno: number;
  cid: number;
  name: string;
}

function buildColumnComment(colName: string, annotation: TableAnnotation) {
  const col = annotation.columns[colName];
  if (!col) return "";

  const parts: string[] = [];

  parts.push(col.description);

  if (col.semanticType) {
    parts.push(`[${col.semanticType}]`);
  }

  if (col.enumValues && col.enumValues.length > 0) {
    parts.push(`Values: ${col.enumValues.join(" | ")}`);
  }

  return parts.join(" ");
}

function formatSqlColumn(
  col: ColumnInfo,
  annotation: TableAnnotation,
  isLast: boolean,
  primaryKeyColumns: string[],
) {
  const parts: string[] = [];

  parts.push(`  ${col.name.padEnd(20)} ${col.type.padEnd(12)}`);

  if (col.notnull === 1 && col.pk === 0) {
    parts.push("NOT NULL");
  }

  if (col.dflt_value !== null && col.dflt_value !== undefined) {
    parts.push(`DEFAULT ${col.dflt_value}`);
  }

  if (col.pk > 0 && primaryKeyColumns.length === 1) {
    parts.push("PRIMARY KEY");
  }

  const suffix = isLast ? "" : ",";

  const definition = parts.join(" ") + suffix;

  const comment = buildColumnComment(col.name, annotation);
  if (comment) {
    const padding = Math.max(1, 80 - definition.length);
    return `${definition}${" ".repeat(padding)}-- ${comment}`;
  }

  return definition;
}

function formatCreateTable(
  tableName: string,
  columns: ColumnInfo[],
  annotation: TableAnnotation,
  kind: "TABLE" | "VIEW",
) {
  const lines: string[] = [];

  lines.push(`-- ${annotation.description}`);
  if (annotation.ttl) {
    lines.push(`-- TTL: ${annotation.ttl}`);
  }
  lines.push(`CREATE ${kind} ${tableName} (`);

  const pkCols = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
  const primaryKeyColumns = pkCols.map((c) => c.name);
  const hasCompositePK = primaryKeyColumns.length > 1;

  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const isLast = i === columns.length - 1 && !hasCompositePK;
    lines.push(formatSqlColumn(col!, annotation, isLast, primaryKeyColumns));
  }

  if (hasCompositePK) {
    lines.push(`  PRIMARY KEY (${primaryKeyColumns.join(", ")})`);
  }

  lines.push(");");
  return lines;
}

function formatCreateIndexes(tableName: string, db: Database, annotation: TableAnnotation) {
  const lines: string[] = [];

  const indexList = db.query(`PRAGMA index_list(${tableName})`).all() as IndexInfo[];

  for (const idx of indexList) {
    if (idx.origin === "pk") continue;

    const indexCols = db.query(`PRAGMA index_info(${idx.name})`).all() as IndexColumnInfo[];
    const colNames = indexCols.sort((a, b) => a.seqno - b.seqno).map((c) => c.name);

    const sqlResult = db
      .query(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get(idx.name) as { sql: string | null } | null;

    if (sqlResult?.sql) {
      const desc = annotation.indexes?.[idx.name];
      if (desc) {
        lines.push(`-- ${desc}`);
      } else {
        lines.push(`-- Index on (${colNames.join(", ")})`);
      }
      lines.push(`${sqlResult.sql};`);
      lines.push("");
    }
  }

  return lines;
}

/**
 * Format full schema as annotated SQL DDL
 */
export function formatSchemaAsSql(tableName: string, annotation: TableAnnotation, db: Database) {
  const lines: string[] = [];

  const columns = db.query(`PRAGMA table_info(${tableName})`).all() as ColumnInfo[];

  const view = db
    .query(`SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = ?`)
    .get(tableName);

  lines.push(...formatCreateTable(tableName, columns, annotation, view ? "VIEW" : "TABLE"));
  lines.push("");

  const indexLines = formatCreateIndexes(tableName, db, annotation);
  if (indexLines.length > 0) {
    lines.push(...indexLines);
  }

  return lines.join("\n");
}
