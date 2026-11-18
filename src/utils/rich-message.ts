import { longToDecimal } from "./attachment";

type RawObject = Record<string, unknown>;

function asObject(value: unknown): RawObject | null {
  return typeof value === "object" && value !== null ? (value as RawObject) : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown): RawObject[] {
  return Array.isArray(value)
    ? value.filter((item): item is RawObject => asObject(item) !== null)
    : [];
}

interface RenderContext {
  documents: Map<string, RawObject>;
}

const INLINE_WRAP: Record<string, [string, string]> = {
  textBold: ["**", "**"],
  textItalic: ["*", "*"],
  textStrike: ["~~", "~~"],
  textFixed: ["`", "`"],
  textMarked: ["==", "=="],
  textSpoiler: ["||", "||"],
  textUnderline: ["<u>", "</u>"],
  textSubscript: ["<sub>", "</sub>"],
  textSuperscript: ["<sup>", "</sup>"],
};

const DATE_FORMAT_FLAGS: Array<[string, string]> = [
  ["relative", "r"],
  ["dayOfWeek", "w"],
  ["shortDate", "d"],
  ["longDate", "D"],
  ["shortTime", "t"],
  ["longTime", "T"],
];

function footnoteId(url: string, prefix: string): string | null {
  return url.startsWith(prefix) ? url.slice(prefix.length) : null;
}

function flatten(node: RawObject): RawObject[] {
  if (node._ !== "textConcat") return [node];
  return list(node.texts).flatMap(flatten);
}

function footnoteReference(node: RawObject): string | null {
  const parts = flatten(node).filter(
    (part) => part._ !== "textEmpty" && !(part._ === "textAnchor" && renderText(part.text) === ""),
  );
  const [link] = parts;
  if (parts.length !== 1 || link?._ !== "textUrl") return null;
  const id = footnoteId(str(link.url), "#fn-");
  return id === null ? null : `[^${id}]`;
}

function buttonPlaceholder(label: string, type: unknown): string {
  const url = str(asObject(type)?.url);
  const text = label || "button";
  return url ? `[button: ${text} (${url})]` : `[button: ${text}]`;
}

/** Inline rich text as rich Markdown */
export function renderText(input: unknown): string {
  const node = asObject(input);
  if (!node) return "";
  const kind = str(node._);
  const inner = () => renderText(node.text);

  const wrap = INLINE_WRAP[kind];
  if (wrap) {
    if (kind === "textSuperscript") {
      const reference = footnoteReference(asObject(node.text) ?? {});
      if (reference) return reference;
    }
    const text = inner();
    return text === "" ? "" : `${wrap[0]}${text}${wrap[1]}`;
  }

  switch (kind) {
    case "textEmpty":
      return "";
    case "textPlain":
      return str(node.text);
    case "textConcat":
      return list(node.texts).map(renderText).join("");
    case "textUrl": {
      const url = str(node.url);
      if (url.startsWith("#") || url === "") return inner();
      return `[${inner()}](${url})`;
    }
    case "textEmail":
      return `[${inner()}](mailto:${str(node.email)})`;
    case "textPhone":
      return `[${inner()}](tel:${str(node.phone)})`;
    case "textMentionName": {
      const id = longToDecimal(node.userId);
      return id ? `[${inner()}](tg://user?id=${id})` : inner();
    }
    case "textMath":
      return `$${str(node.source)}$`;
    case "textCustomEmoji":
      return str(node.alt);
    case "textImage":
      return "[image]";
    case "textDate": {
      const format = DATE_FORMAT_FLAGS.filter(([flag]) => node[flag] === true)
        .map(([, letter]) => letter)
        .join("");
      const query = format ? `&format=${format}` : "";
      return `![${inner()}](tg://time?unix=${Number(node.date) || 0}${query})`;
    }
    case "textButton":
      return buttonPlaceholder(inner(), node.type);
    default:
      if ("text" in node) return inner();
      if (Array.isArray(node.texts)) return list(node.texts).map(renderText).join("");
      return `[${kind || "unknown text"}]`;
  }
}

function renderCaption(input: unknown): string {
  const caption = asObject(input);
  if (!caption) return "";
  if (caption._ !== "pageCaption") return renderText(caption);
  const text = renderText(caption.text);
  const credit = renderText(caption.credit);
  return [text, credit].filter(Boolean).join(" — ");
}

function placeholder(label: string, caption: unknown): string {
  const text = renderCaption(caption);
  return text ? `[${label}: ${text}]` : `[${label}]`;
}

function fileLabel(kind: string, idField: unknown, context: RenderContext): string {
  const id = longToDecimal(idField);
  const doc = id ? context.documents.get(id) : undefined;
  let name = "";
  for (const attr of list(doc?.attributes)) {
    if (attr._ === "documentAttributeFilename") name ||= str(attr.fileName);
    if (attr._ === "documentAttributeAudio" && attr.title) {
      const performer = str(attr.performer);
      name = performer ? `${performer} — ${str(attr.title)}` : str(attr.title);
    }
  }
  return name ? `${kind} ${name}` : kind;
}

function indent(text: string, prefix: string, first = prefix): string {
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? first + line : line === "" ? "" : prefix + line))
    .join("\n");
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

function fence(text: string, info: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const marker = "`".repeat(longest + 1);
  return `${marker}${info}\n${text}\n${marker}`;
}

function renderListItem(item: RawObject, marker: string, context: RenderContext): string {
  const box = item.checkbox === true ? (item.checked ? "[x] " : "[ ] ") : "";
  const body = "blocks" in item ? renderBlocks(item.blocks, context) : renderText(item.text);
  return indent(`${box}${body}`, " ".repeat(marker.length), marker);
}

function renderList(block: RawObject, context: RenderContext): string {
  return list(block.items)
    .map((item) => renderListItem(item, "- ", context))
    .join("\n");
}

function renderOrderedList(block: RawObject, context: RenderContext): string {
  const start = typeof block.start === "number" ? block.start : 1;
  return list(block.items)
    .map((item, i) => {
      const num = str(item.num) || String(start + i);
      return renderListItem(item, `${num.replace(/\.$/, "")}. `, context);
    })
    .join("\n");
}

function cellText(cell: RawObject): string {
  return renderText(cell.text).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function alignment(cell: RawObject | undefined): string {
  if (cell?.alignCenter === true) return ":---:";
  if (cell?.alignRight === true) return "---:";
  return "---";
}

function renderTable(block: RawObject): string {
  const rows = list(block.rows).map((row) =>
    list(row.cells).flatMap((cell) => {
      const span = typeof cell.colspan === "number" ? cell.colspan : 1;
      return [cell, ...Array<RawObject>(Math.max(0, span - 1)).fill({})];
    }),
  );
  const title = renderText(block.title);
  if (rows.length === 0) return title;
  const width = Math.max(...rows.map((row) => row.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  const [header = [], ...body] = rows;
  const aligns = Array.from({ length: width }, (_, i) => alignment(body[0]?.[i] ?? header[i]));
  const table = [
    line(header.map(cellText)),
    `|${aligns.join("|")}|`,
    ...body.map((row) => line(row.map(cellText))),
  ].join("\n");
  return title ? `${title}\n\n${table}` : table;
}

function renderFooter(text: unknown): string {
  const parts = flatten(asObject(text) ?? {});
  const anchor = parts.find(
    (part) => part._ === "textAnchor" && footnoteId(str(part.name), "fn-") !== null,
  );
  if (!anchor) return renderText(text);
  const id = footnoteId(str(anchor.name), "fn-");
  const definition = parts
    .slice(parts.indexOf(anchor) + 1)
    .filter((part) => !(part._ === "textUrl" && str(part.url).startsWith("#fnref-")));
  return `[^${id}]: ${renderText(anchor.text)}${definition.map(renderText).join("")}`.trimEnd();
}

function renderButtons(block: RawObject): string {
  return list(block.buttons)
    .map((button) => buttonPlaceholder(renderText(button.text), button.type))
    .join(" ");
}

function renderMap(block: RawObject): string {
  const geo = asObject(block.geo);
  const at =
    typeof geo?.lat === "number" && typeof geo.long === "number" ? ` ${geo.lat}, ${geo.long}` : "";
  return placeholder(`map${at}`, block.caption);
}

function renderMediaGroup(tag: string, block: RawObject, context: RenderContext): string {
  const items = list(block.items).map((item) => renderBlock(item, context));
  const caption = renderCaption(block.caption);
  const body = caption ? [...items, `<figcaption>${caption}</figcaption>`] : items;
  return `<${tag}>\n\n${body.join("\n")}\n\n</${tag}>`;
}

function renderBlock(block: RawObject, context: RenderContext): string {
  const kind = str(block._);
  const text = () => renderText(block.text);
  const heading = /^pageBlockHeading([1-6])$/.exec(kind);
  if (heading) return `${"#".repeat(Number(heading[1]))} ${text()}`;

  switch (kind) {
    case "pageBlockTitle":
      return `# ${text()}`;
    case "pageBlockSubtitle":
    case "pageBlockHeader":
      return `## ${text()}`;
    case "pageBlockSubheader":
      return `### ${text()}`;
    case "pageBlockParagraph":
    case "pageBlockKicker":
      return text();
    case "pageBlockFooter":
      return renderFooter(block.text);
    case "pageBlockAuthorDate": {
      const date =
        typeof block.publishedDate === "number" && block.publishedDate > 0
          ? new Date(block.publishedDate * 1000).toISOString().slice(0, 10)
          : "";
      return [renderText(block.author), date].filter(Boolean).join(", ");
    }
    case "pageBlockPreformatted":
      return fence(text(), str(block.language));
    case "pageBlockDivider":
      return "---";
    case "pageBlockAnchor":
      return "";
    case "pageBlockList":
      return renderList(block, context);
    case "pageBlockOrderedList":
      return renderOrderedList(block, context);
    case "pageBlockBlockquote":
    case "pageBlockBlockquoteBlocks": {
      const body = kind === "pageBlockBlockquote" ? text() : renderBlocks(block.blocks, context);
      const caption = renderText(block.caption);
      return quote(caption ? `${body}\n<cite>${caption}</cite>` : body);
    }
    case "pageBlockPullquote": {
      const caption = renderText(block.caption);
      return `<aside>${text()}${caption ? `<cite>${caption}</cite>` : ""}</aside>`;
    }
    case "pageBlockTable":
      return renderTable(block);
    case "pageBlockDetails":
      return `<details${block.open === true ? " open" : ""}><summary>${renderText(block.title)}</summary>\n\n${renderBlocks(block.blocks, context)}\n\n</details>`;
    case "pageBlockMath":
      return `$$${str(block.source)}$$`;
    case "pageBlockThinking":
      return `<tg-thinking>${text()}</tg-thinking>`;
    case "pageBlockPhoto":
      return placeholder("photo", block.caption);
    case "pageBlockVideo":
      return placeholder(fileLabel("video", block.videoId, context), block.caption);
    case "pageBlockAudio":
      return placeholder(fileLabel("audio", block.audioId, context), block.caption);
    case "pageBlockDocument":
      return placeholder(fileLabel("document", block.documentId, context), block.caption);
    case "pageBlockMap":
    case "inputPageBlockMap":
      return renderMap(block);
    case "pageBlockEmbed": {
      const url = str(block.url);
      return placeholder(url ? `embed ${url}` : "embed", block.caption);
    }
    case "pageBlockEmbedPost": {
      const by = [str(block.author), str(block.url)].filter(Boolean).join(" ");
      const head = placeholder(by ? `post ${by}` : "post", block.caption);
      const body = renderBlocks(block.blocks, context);
      return body ? `${head}\n${quote(body)}` : head;
    }
    case "pageBlockCollage":
      return renderMediaGroup("tg-collage", block, context);
    case "pageBlockSlideshow":
      return renderMediaGroup("tg-slideshow", block, context);
    case "pageBlockCover":
      return renderBlock(asObject(block.cover) ?? {}, context);
    case "pageBlockChannel": {
      const chat = asObject(block.channel);
      const name = [str(chat?.title), chat?.username ? `@${chat.username}` : ""]
        .filter(Boolean)
        .join(" ");
      return name ? `[channel: ${name}]` : "[channel]";
    }
    case "pageBlockRelatedArticles": {
      const articles = list(block.articles).map((article) => {
        const title = str(article.title) || str(article.url);
        return str(article.url) ? `- [${title}](${str(article.url)})` : `- ${title}`;
      });
      return [renderText(block.title), ...articles].filter(Boolean).join("\n");
    }
    case "pageBlockButtonRow":
      return renderButtons(block);
    case "pageBlockUnsupported":
      return "[unsupported block]";
    default:
      if ("text" in block) return text();
      if (Array.isArray(block.blocks)) return renderBlocks(block.blocks, context);
      return `[${kind || "unknown block"}]`;
  }
}

function renderBlocks(blocks: unknown, context: RenderContext): string {
  return list(blocks)
    .map((block) => renderBlock(block, context))
    .filter((text) => text !== "")
    .join("\n\n");
}

/** A richMessage object as rich Markdown */
export function renderRichMessage(input: unknown): string {
  const rich = asObject(input);
  if (!rich) return "";
  const documents = new Map<string, RawObject>();
  for (const doc of list(rich.documents)) {
    const id = longToDecimal(doc.id);
    if (id) documents.set(id, doc);
  }
  return renderBlocks(rich.blocks, { documents }).trim();
}

/**
 * The text of a TL message's rich content, from the message object or its
 * raw_json; null when it has none, so a caller keeps the message's own text
 */
export function richMessageText(message: unknown): string | null {
  let value = message;
  if (typeof value === "string") {
    if (!value.includes('"richMessage"')) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const rich = asObject(asObject(value)?.richMessage);
  if (rich?._ !== "richMessage") return null;
  return renderRichMessage(rich) || null;
}
