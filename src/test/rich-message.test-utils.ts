import { Long, type tl } from "@mtcute/bun";

export const plain = (text: string) => {
  const result: tl.RawTextPlain = {
    _: "textPlain",
    text,
  };
  return result;
};

export const concat = (...texts: tl.TypeRichText[]) => {
  const result: tl.RawTextConcat = {
    _: "textConcat",
    texts,
  };
  return result;
};

export const paragraph = (text: tl.TypeRichText | string) => {
  const result: tl.RawPageBlockParagraph = {
    _: "pageBlockParagraph",
    text: typeof text === "string" ? plain(text) : text,
  };
  return result;
};

export function cell(text: tl.TypeRichText | string, extra: Partial<tl.RawPageTableCell> = {}) {
  const result: tl.RawPageTableCell = {
    _: "pageTableCell",
    text: typeof text === "string" ? plain(text) : text,
    ...extra,
  };
  return result;
}

export function richMessage(blocks: tl.TypePageBlock[], extra: Partial<tl.RawRichMessage> = {}) {
  const result: tl.RawRichMessage = {
    _: "richMessage",
    blocks,
    photos: [],
    documents: [],
    ...extra,
  };
  return result;
}

/** A message whose content is these blocks: its own text is empty */
export function richTlMessage(
  peerId: tl.TypePeer,
  id: number,
  blocks: tl.TypePageBlock[],
  extra: Partial<tl.RawRichMessage> = {},
) {
  const result: tl.RawMessage = {
    _: "message",
    id,
    peerId,
    date: 1_760_000_000 + id,
    message: "",
    richMessage: richMessage(blocks, extra),
  };
  return result;
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
export function namedDocument(id: string, fileName: string) {
  const result: tl.RawDocument = {
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
  return result;
}
