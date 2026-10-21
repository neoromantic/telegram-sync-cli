import type { SyncJobStatus } from '../../db/sync-schema'

export const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
}

export const icons = {
  running: '●',
  stopped: '○',
  success: '✓',
  error: '✗',
  warning: '⚠',
  pending: '◌',
  arrow: '→',
  bullet: '•',
  line: '─',
}

export const c = {
  bold: (s: string) => `${colors.bold}${s}${colors.reset}`,
  dim: (s: string) => `${colors.dim}${s}${colors.reset}`,
  red: (s: string) => `${colors.red}${s}${colors.reset}`,
  green: (s: string) => `${colors.green}${s}${colors.reset}`,
  yellow: (s: string) => `${colors.yellow}${s}${colors.reset}`,
  blue: (s: string) => `${colors.blue}${s}${colors.reset}`,
  cyan: (s: string) => `${colors.cyan}${s}${colors.reset}`,
  magenta: (s: string) => `${colors.magenta}${s}${colors.reset}`,
  gray: (s: string) => `${colors.gray}${s}${colors.reset}`,
  success: (s: string) => `${colors.green}${colors.bold}${s}${colors.reset}`,
  warning: (s: string) => `${colors.yellow}${colors.bold}${s}${colors.reset}`,
  error: (s: string) => `${colors.red}${colors.bold}${s}${colors.reset}`,
  info: (s: string) => `${colors.cyan}${s}${colors.reset}`,
  header: (s: string) => `${colors.bold}${colors.blue}${s}${colors.reset}`,
  label: (s: string) => `${colors.gray}${s}${colors.reset}`,
  value: (s: string) => `${colors.white}${s}${colors.reset}`,
  number: (s: string | number) =>
    `${colors.cyan}${colors.bold}${s}${colors.reset}`,
}

export function printHeader(title: string): void {
  const line = icons.line.repeat(40)
  console.log()
  console.log(c.header(`${icons.bullet} ${title}`))
  console.log(c.dim(line))
}

export function printRow(label: string, value: string, indent = 2): void {
  const padding = ' '.repeat(indent)
  const labelWidth = 20
  const paddedLabel = label.padEnd(labelWidth)
  console.log(`${padding}${c.label(paddedLabel)} ${value}`)
}

export function jobStatusIcon(status: SyncJobStatus): string {
  if (status === 'running') return c.success(icons.running)
  if (status === 'failed') return c.red(icons.error)
  return c.yellow(icons.pending)
}
