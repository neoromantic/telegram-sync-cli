/**
 * CSV formatting utilities
 * Manual implementation following RFC 4180
 */

export interface CsvOptions {
  /** Include header row (default: true) */
  includeHeader?: boolean;
  /** Field delimiter (default: ',') */
  delimiter?: string;
}

const DEFAULT_OPTIONS: Required<CsvOptions> = {
  includeHeader: true,
  delimiter: ",",
};

function escapeValue(value: unknown, delimiter: string): string {
  if (value === null || value === undefined) {
    return "";
  }

  const str = String(value);

  const needsQuoting =
    str.includes(delimiter) || str.includes('"') || str.includes("\n") || str.includes("\r");

  if (!needsQuoting) {
    return str;
  }

  const escaped = str.replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * Convert an array of objects to CSV string
 */
export function stringify<T extends Record<string, unknown>>(
  data: T[],
  columns?: string[],
  options: CsvOptions = {},
): string {
  const opts: Required<CsvOptions> = { ...DEFAULT_OPTIONS, ...options };

  if (data.length === 0) {
    if (columns && opts.includeHeader) {
      return columns.map((h) => escapeValue(h, opts.delimiter)).join(opts.delimiter);
    }
    return "";
  }

  const headers = columns ?? Object.keys(data[0]!);

  const lines: string[] = [];

  if (opts.includeHeader) {
    lines.push(headers.map((h) => escapeValue(h, opts.delimiter)).join(opts.delimiter));
  }

  for (const row of data) {
    const values = headers.map((header) => {
      const value = row[header];
      return escapeValue(value, opts.delimiter);
    });
    lines.push(values.join(opts.delimiter));
  }

  return lines.join("\n");
}

/**
 * Convert headers and rows (table format) to CSV string
 * Compatible with SQL query results
 */
export function stringifyTable(
  columns: string[],
  rows: Record<string, unknown>[],
  options: CsvOptions = {},
): string {
  return stringify(rows, columns, options);
}
