/**
 * Rich messages (page blocks instead of a text) as mtcute gives them, with
 * made-up content. The shape follows what Telegram returns for a message
 * sent with rich Markdown.
 */
import { Long, type tl } from "@mtcute/bun";

export const plain = (text: string): tl.RawTextPlain => ({
  _: "textPlain",
  text,
});

export const concat = (...texts: tl.TypeRichText[]): tl.RawTextConcat => ({
  _: "textConcat",
  texts,
});

export const paragraph = (text: tl.TypeRichText | string): tl.RawPageBlockParagraph => ({
  _: "pageBlockParagraph",
  text: typeof text === "string" ? plain(text) : text,
});

export function cell(
  text: tl.TypeRichText | string,
  extra: Partial<tl.RawPageTableCell> = {},
): tl.RawPageTableCell {
  return {
    _: "pageTableCell",
    text: typeof text === "string" ? plain(text) : text,
    ...extra,
  };
}

export function richMessage(
  blocks: tl.TypePageBlock[],
  extra: Partial<tl.RawRichMessage> = {},
): tl.RawRichMessage {
  return {
    _: "richMessage",
    blocks,
    photos: [],
    documents: [],
    ...extra,
  };
}

/** A message whose content is these blocks: its own text is empty */
export function richTlMessage(
  peerId: tl.TypePeer,
  id: number,
  blocks: tl.TypePageBlock[],
  extra: Partial<tl.RawRichMessage> = {},
): tl.RawMessage {
  return {
    _: "message",
    id,
    peerId,
    date: 1_760_000_000 + id,
    message: "",
    richMessage: richMessage(blocks, extra),
  };
}

/** A short made-up report: a heading, a paragraph and a table */
export const REPORT_BLOCKS: tl.TypePageBlock[] = [
  { _: "pageBlockHeading1", text: plain("Garden report") },
  paragraph(concat(plain("Harvest is "), { _: "textBold", text: plain("on track") })),
  {
    _: "pageBlockTable",
    title: { _: "textEmpty" },
    rows: [
      {
        _: "pageTableRow",
        cells: [cell("Crop", { header: true }), cell("Kg", { header: true, alignRight: true })],
      },
      {
        _: "pageTableRow",
        cells: [cell("Zucchini"), cell("12", { alignRight: true })],
      },
    ],
  },
];

export const REPORT_TEXT = [
  "# Garden report",
  "",
  "Harvest is **on track**",
  "",
  "| Crop | Kg |",
  "|---|---:|",
  "| Zucchini | 12 |",
].join("\n");

/** A document of a rich message, with this file name */
export function namedDocument(id: string, fileName: string): tl.RawDocument {
  return {
    _: "document",
    id: Long.fromString(id),
    accessHash: Long.fromString("5000000000000000001"),
    fileReference: new Uint8Array([1, 2, 3]),
    date: 1_760_000_000,
    mimeType: "application/pdf",
    size: 2048,
    dcId: 2,
    attributes: [{ _: "documentAttributeFilename", fileName }],
  };
}
