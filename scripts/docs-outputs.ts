import { z } from "zod";
import { chatsListOutput } from "../src/commands/chats/list-output";

const OUTPUTS: Record<string, z.ZodType> = {
  "chats list": chatsListOutput,
};

export const DOC_PATH = `${import.meta.dir}/../docs/cli-commands.md`;

interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  anyOf?: JsonSchema[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
}

function alternatives(schema: JsonSchema) {
  if (schema.anyOf) {
    const names: string[] = schema.anyOf.flatMap(alternatives);
    return names;
  }
  if (schema.enum) return schema.enum.map((value) => `\`${value}\``);
  const types = [schema.type ?? "unknown"].flat();
  return types.map((type) => (type === "null" ? "`null`" : type));
}

function typeName(schema: JsonSchema) {
  if (schema.type === "array") return "array";
  const names = alternatives(schema);
  const last = names.pop();
  return names.length > 0 ? `${names.join(", ")} or ${last}` : `${last}`;
}

function rows(schema: JsonSchema, prefix = "") {
  return Object.entries(schema.properties ?? {}).flatMap(([key, field]) => {
    const row = `| \`${prefix}${key}\` | ${typeName(field)} | ${field.description ?? ""} |`;
    const nested: string[] = field.items?.properties ? rows(field.items, `${prefix}${key}[].`) : [];
    return [row, ...nested];
  });
}

export function renderTable(output: z.ZodType) {
  const schema = z.toJSONSchema(output) as JsonSchema;
  return ["| Field | Type | Description |", "|---|---|---|", ...rows(schema)]
    .join("\n")
    .concat("\n");
}

/** The doc with every output table regenerated */
export function updateDoc(doc: string) {
  return doc.replace(
    /(<!-- output: (.+?) -->\n)[\s\S]*?(<!-- \/output -->)/g,
    (_, open: string, command: string, close: string) => {
      const output = OUTPUTS[command];
      if (!output) throw new Error(`No output declared for "${command}"`);
      return `${open}${renderTable(output)}${close}`;
    },
  );
}

if (import.meta.main) {
  const doc = await Bun.file(DOC_PATH).text();
  await Bun.write(DOC_PATH, updateDoc(doc));
}
