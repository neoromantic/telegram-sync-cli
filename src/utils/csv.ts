/**
 * CSV formatting utilities
 * Manual implementation following RFC 4180
 */

export interface CsvOptions {
  /** Include header row (default: true) */
  includeHeader?: boolean
  /** Field delimiter (default: ',') */
  delimiter?: string
}

const DEFAULT_OPTIONS: Required<CsvOptions> = {
  includeHeader: true,
  delimiter: ',',
}

/**
 * Escape a value for CSV output
 * Handles quotes, newlines, and the delimiter character
 */
function escapeValue(value: unknown, delimiter: string): string {
  // Handle null/undefined
  if (value === null || value === undefined) {
    return ''
  }

  const str = String(value)

  // Check if quoting is needed
  const needsQuoting =
    str.includes(delimiter) ||
    str.includes('"') ||
    str.includes('\n') ||
    str.includes('\r')

  if (!needsQuoting) {
    return str
  }

  // Escape quotes by doubling them (RFC 4180)
  const escaped = str.replace(/"/g, '""')
  return `"${escaped}"`
}

/**
 * Convert an array of objects to CSV string
 */
export function stringify<T extends Record<string, unknown>>(
  data: T[],
  columns?: string[],
  options: CsvOptions = {},
): string {
  const opts: Required<CsvOptions> = { ...DEFAULT_OPTIONS, ...options }

  if (data.length === 0) {
    // Return just headers if we have columns specified
    if (columns && opts.includeHeader) {
      return columns
        .map((h) => escapeValue(h, opts.delimiter))
        .join(opts.delimiter)
    }
    return ''
  }

  // Determine headers from first object if not provided
  const headers = columns ?? Object.keys(data[0]!)

  const lines: string[] = []

  // Add header row
  if (opts.includeHeader) {
    const headerLine = headers
      .map((h) => escapeValue(h, opts.delimiter))
      .join(opts.delimiter)
    lines.push(headerLine)
  }

  // Add data rows
  for (const row of data) {
    const values = headers.map((header) => {
      const value = row[header]
      return escapeValue(value, opts.delimiter)
    })
    lines.push(values.join(opts.delimiter))
  }

  return lines.join('\n')
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
  return stringify(rows, columns, options)
}
