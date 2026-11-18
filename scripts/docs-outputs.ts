/**
 * Writes each declared command output into docs/cli-commands.md as a field
 * table, between `<!-- output: <command> -->` and `<!-- /output -->`.
 * `bun run docs:outputs`; src/__tests__/docs-outputs.test.ts fails when the
 * file is out of date.
 */
import { z } from 'zod'
import { chatsListOutput } from '../src/commands/chats/list-output'

const OUTPUTS: Record<string, z.ZodType> = {
  'chats list': chatsListOutput,
}

export const DOC_PATH = `${import.meta.dir}/../docs/cli-commands.md`

interface JsonSchema {
  type?: string | string[]
  enum?: unknown[]
  anyOf?: JsonSchema[]
  description?: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
}

function alternatives(schema: JsonSchema): string[] {
  if (schema.anyOf) return schema.anyOf.flatMap(alternatives)
  if (schema.enum) return schema.enum.map((value) => `\`${value}\``)
  const types = [schema.type ?? 'unknown'].flat()
  return types.map((type) => (type === 'null' ? '`null`' : type))
}

function typeName(schema: JsonSchema): string {
  if (schema.type === 'array') return 'array'
  const names = alternatives(schema)
  const last = names.pop()
  return names.length > 0 ? `${names.join(', ')} or ${last}` : `${last}`
}

function rows(schema: JsonSchema, prefix = ''): string[] {
  return Object.entries(schema.properties ?? {}).flatMap(([key, field]) => {
    const row = `| \`${prefix}${key}\` | ${typeName(field)} | ${field.description ?? ''} |`
    const nested = field.items?.properties
      ? rows(field.items, `${prefix}${key}[].`)
      : []
    return [row, ...nested]
  })
}

export function renderTable(output: z.ZodType): string {
  const schema = z.toJSONSchema(output) as JsonSchema
  return ['| Field | Type | Description |', '|---|---|---|', ...rows(schema)]
    .join('\n')
    .concat('\n')
}

/** The doc with every output table regenerated */
export function updateDoc(doc: string): string {
  return doc.replace(
    /(<!-- output: (.+?) -->\n)[\s\S]*?(<!-- \/output -->)/g,
    (_, open: string, command: string, close: string) => {
      const output = OUTPUTS[command]
      if (!output) throw new Error(`No output declared for "${command}"`)
      return `${open}${renderTable(output)}${close}`
    },
  )
}

if (import.meta.main) {
  const doc = await Bun.file(DOC_PATH).text()
  await Bun.write(DOC_PATH, updateDoc(doc))
}
