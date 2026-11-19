import { describe, expect, it } from "bun:test";
import { Long, type tl } from "@mtcute/bun";

import { toRawJson } from "./raw-json";
import { richMessageText } from "./rich-message";
import {
  cell,
  concat,
  namedDocument,
  paragraph,
  plain,
  richTlMessage,
} from "../test/rich-message.test-utils";

const peerId = { _: "peerUser" as const, userId: 1001 };

function render(blocks: tl.TypePageBlock[], extra: Partial<tl.RawRichMessage> = {}) {
  const message = richTlMessage(peerId, 7, blocks, extra);
  const cached = richMessageText(toRawJson(message));
  expect(richMessageText(message)).toBe(cached);
  return cached;
}

const inline = (text: tl.TypeRichText) => render([paragraph(text)]);

const url = (text: string, href: string) => {
  const result: tl.RawTextUrl = {
    _: "textUrl",
    text: plain(text),
    url: href,
    webpageId: Long.ZERO,
  };
  return result;
};

const caption = (text: string, credit = "") => {
  const result: tl.RawPageCaption = {
    _: "pageCaption",
    text: text ? plain(text) : { _: "textEmpty" },
    credit: credit ? plain(credit) : { _: "textEmpty" },
  };
  return result;
};

describe("richMessageText: inline text", () => {
  it("writes each style in its rich Markdown syntax", () => {
    const styled = (
      kind:
        | "textBold"
        | "textItalic"
        | "textStrike"
        | "textFixed"
        | "textMarked"
        | "textSpoiler"
        | "textUnderline"
        | "textSubscript"
        | "textSuperscript",
    ) => inline({ _: kind, text: plain("word") });

    expect(styled("textBold")).toBe("**word**");
    expect(styled("textItalic")).toBe("*word*");
    expect(styled("textStrike")).toBe("~~word~~");
    expect(styled("textFixed")).toBe("`word`");
    expect(styled("textMarked")).toBe("==word==");
    expect(styled("textSpoiler")).toBe("||word||");
    expect(styled("textUnderline")).toBe("<u>word</u>");
    expect(styled("textSubscript")).toBe("<sub>word</sub>");
    expect(styled("textSuperscript")).toBe("<sup>word</sup>");
  });

  it("nests styles and joins concatenations", () => {
    expect(
      inline(
        concat(
          plain("Very "),
          {
            _: "textBold",
            text: concat(plain("bold "), {
              _: "textItalic",
              text: plain("and italic"),
            }),
          },
          { _: "textEmpty" },
        ),
      ),
    ).toBe("Very **bold *and italic***");
  });

  it("writes links, e-mail, phone and user mentions as Markdown links", () => {
    expect(inline(url("the site", "https://example.com/"))).toBe(
      "[the site](https://example.com/)",
    );
    expect(
      inline({
        _: "textEmail",
        text: plain("write us"),
        email: "team@example.com",
      }),
    ).toBe("[write us](mailto:team@example.com)");
    expect(inline({ _: "textPhone", text: plain("call"), phone: "+15550000000" })).toBe(
      "[call](tel:+15550000000)",
    );
    expect(inline({ _: "textMentionName", text: plain("Ada"), userId: 1002 })).toBe(
      "[Ada](tg://user?id=1002)",
    );
  });

  it("keeps only the text of in-document links and anchors", () => {
    expect(inline(url("see above", "#intro"))).toBe("see above");
    expect(inline({ _: "textAnchor", text: plain("Intro"), name: "intro" })).toBe("Intro");
  });

  it("writes formulas, custom emoji, images and dates", () => {
    expect(inline({ _: "textMath", source: "a^2 + b^2" })).toBe("$a^2 + b^2$");
    expect(
      inline({
        _: "textCustomEmoji",
        documentId: Long.fromString("5000000000000000002"),
        alt: "👍",
      }),
    ).toBe("👍");
    expect(
      inline({
        _: "textImage",
        documentId: Long.fromString("5000000000000000003"),
        w: 16,
        h: 16,
      }),
    ).toBe("[image]");
    expect(
      inline({
        _: "textDate",
        dayOfWeek: true,
        shortTime: true,
        text: plain("Mon 09:00"),
        date: 1_760_000_000,
      }),
    ).toBe("![Mon 09:00](tg://time?unix=1760000000&format=wt)");
  });

  it("reads entities, a diff and a text type it does not know by their text, else names it", () => {
    const kinds = [
      "textMention",
      "textHashtag",
      "textBotCommand",
      "textCashtag",
      "textAutoUrl",
      "textAutoEmail",
      "textAutoPhone",
      "textBankCard",
      "textTonAddress",
    ] as const;
    for (const kind of kinds) {
      expect(inline({ _: kind, text: plain("#value") })).toBe("#value");
    }
    expect(inline({ _: "textDiff", text: plain("new"), oldText: plain("old") })).toBe("new");
    const future = { _: "textSparkle", text: plain("shiny") };
    const bare = { _: "textHologram", id: 1 };
    expect(inline(future as unknown as tl.TypeRichText)).toBe("shiny");
    expect(inline(bare as unknown as tl.TypeRichText)).toBe("[textHologram]");
  });

  it("writes an inline button as a placeholder with its label and link", () => {
    expect(
      inline({
        _: "textButton",
        text: plain("Open"),
        type: { _: "inlineButtonTypeUrl", url: "https://example.com/" },
      }),
    ).toBe("[button: Open (https://example.com/)]");
  });
});

describe("richMessageText: blocks", () => {
  it("writes headings of every level", () => {
    const headings = ([1, 2, 3, 4, 5, 6] as const).map((level) => {
      const result: tl.TypePageBlock = {
        _: `pageBlockHeading${level}`,
        text: plain(`Level ${level}`),
      };
      return result;
    });
    expect(render(headings)).toBe(
      "# Level 1\n\n## Level 2\n\n### Level 3\n\n#### Level 4\n\n##### Level 5\n\n###### Level 6",
    );
  });

  it("writes the article blocks of older pages as headings and lines", () => {
    expect(
      render([
        { _: "pageBlockTitle", text: plain("Title") },
        { _: "pageBlockSubtitle", text: plain("Subtitle") },
        { _: "pageBlockHeader", text: plain("Header") },
        { _: "pageBlockSubheader", text: plain("Subheader") },
        { _: "pageBlockKicker", text: plain("Kicker") },
        {
          _: "pageBlockAuthorDate",
          author: plain("Sam Example"),
          publishedDate: 1_760_000_000,
        },
        { _: "pageBlockAnchor", name: "top" },
      ]),
    ).toBe(
      "# Title\n\n## Subtitle\n\n## Header\n\n### Subheader\n\nKicker\n\nSam Example, 2025-10-09",
    );
  });

  it("writes code with its language, a divider and formulas", () => {
    expect(
      render([
        {
          _: "pageBlockPreformatted",
          text: plain('print("hi")'),
          language: "python",
        },
        { _: "pageBlockDivider" },
        { _: "pageBlockMath", source: "\\frac{1}{2}" },
      ]),
    ).toBe('```python\nprint("hi")\n```\n\n---\n\n$$\\frac{1}{2}$$');
    expect(
      render([
        {
          _: "pageBlockPreformatted",
          text: plain("```\nnested\n```"),
          language: "",
        },
      ]),
    ).toBe("````\n```\nnested\n```\n````");
  });

  it("writes lists, ordered lists and task lists", () => {
    expect(
      render([
        {
          _: "pageBlockList",
          items: [
            { _: "pageListItemText", text: plain("milk") },
            {
              _: "pageListItemText",
              checkbox: true,
              checked: true,
              text: plain("eggs"),
            },
            { _: "pageListItemText", checkbox: true, text: plain("bread") },
          ],
        },
        {
          _: "pageBlockOrderedList",
          items: [
            { _: "pageListOrderedItemText", num: "1", text: plain("first") },
            { _: "pageListOrderedItemText", num: "2", text: plain("second") },
          ],
        },
        {
          _: "pageBlockOrderedList",
          start: 4,
          items: [
            { _: "pageListOrderedItemText", text: plain("fourth") },
            {
              _: "pageListOrderedItemBlocks",
              blocks: [paragraph("fifth"), paragraph("more of it")],
            },
          ],
        },
      ]),
    ).toBe(
      [
        "- milk",
        "- [x] eggs",
        "- [ ] bread",
        "",
        "1. first",
        "2. second",
        "",
        "4. fourth",
        "5. fifth",
        "",
        "   more of it",
      ].join("\n"),
    );
  });

  it("writes quotations with their caption, and a pull quote as <aside>", () => {
    expect(
      render([
        {
          _: "pageBlockBlockquote",
          text: plain("Line one\nLine two"),
          caption: plain("A. Writer"),
        },
        {
          _: "pageBlockBlockquoteBlocks",
          blocks: [paragraph("First"), paragraph("Second")],
          caption: { _: "textEmpty" },
        },
        {
          _: "pageBlockPullquote",
          text: plain("Big words"),
          caption: plain("B. Speaker"),
        },
      ]),
    ).toBe(
      [
        "> Line one",
        "> Line two",
        "> <cite>A. Writer</cite>",
        "",
        "> First",
        ">",
        "> Second",
        "",
        "<aside>Big words<cite>B. Speaker</cite></aside>",
      ].join("\n"),
    );
  });

  it("writes a table with alignment, styled cells, spans, a title and pipes escaped", () => {
    expect(
      render([
        {
          _: "pageBlockTable",
          title: plain("Prices"),
          rows: [
            {
              _: "pageTableRow",
              cells: [
                cell("Item", { header: true }),
                cell("Note", { header: true, alignCenter: true }),
                cell("Cost", { header: true, alignRight: true }),
              ],
            },
            {
              _: "pageTableRow",
              cells: [
                cell({ _: "textBold", text: plain("Tea") }),
                cell("green | loose", { alignCenter: true }),
                cell("3", { alignRight: true }),
              ],
            },
            {
              _: "pageTableRow",
              cells: [cell("Total", { colspan: 2 }), cell("3")],
            },
          ],
        },
      ]),
    ).toBe(
      [
        "Prices",
        "",
        "| Item | Note | Cost |",
        "|---|:---:|---:|",
        "| **Tea** | green \\| loose | 3 |",
        "| Total |  | 3 |",
      ].join("\n"),
    );
  });

  it("writes details as <details> with Markdown inside, a list in it too", () => {
    expect(
      render([
        {
          _: "pageBlockDetails",
          open: true,
          title: concat(plain("More "), {
            _: "textBold",
            text: plain("here"),
          }),
          blocks: [
            paragraph("Inside"),
            {
              _: "pageBlockList",
              items: [
                {
                  _: "pageListItemBlocks",
                  blocks: [
                    paragraph("outer"),
                    {
                      _: "pageBlockList",
                      items: [{ _: "pageListItemText", text: plain("inner") }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          _: "pageBlockDetails",
          title: plain("Closed"),
          blocks: [paragraph("Hidden")],
        },
      ]),
    ).toBe(
      [
        "<details open><summary>More **here**</summary>",
        "",
        "Inside",
        "",
        "- outer",
        "",
        "  - inner",
        "",
        "</details>",
        "",
        "<details><summary>Closed</summary>",
        "",
        "Hidden",
        "",
        "</details>",
      ].join("\n"),
    );
  });

  it("writes footnotes as Telegram returns them: [^id] and [^id]: text", () => {
    expect(
      render([
        paragraph(
          concat(plain("A claim"), {
            _: "textSuperscript",
            text: concat(
              { _: "textAnchor", text: { _: "textEmpty" }, name: "fnref-n-1" },
              url("1", "#fn-n"),
            ),
          }),
        ),
        {
          _: "pageBlockFooter",
          text: concat(
            plain("1. "),
            { _: "textAnchor", text: plain("The source."), name: "fn-n" },
            plain(" "),
            url("↩", "#fnref-n-1"),
          ),
        },
        { _: "pageBlockFooter", text: plain("Plain footer") },
      ]),
    ).toBe("A claim[^n]\n\n[^n]: The source.\n\nPlain footer");
  });

  it("writes media, maps, embeds and channels as placeholders with captions", () => {
    const docs = [
      namedDocument("5000000000000000010", "plan.pdf"),
      {
        ...namedDocument("5000000000000000011", "song.mp3"),
        attributes: [
          {
            _: "documentAttributeAudio" as const,
            duration: 60,
            title: "Tune",
            performer: "Band",
          },
        ],
      },
    ];
    expect(
      render(
        [
          {
            _: "pageBlockPhoto",
            photoId: Long.fromString("5000000000000000020"),
            caption: caption("Lake", "Photo: Sam"),
          },
          {
            _: "pageBlockVideo",
            videoId: Long.fromString("5000000000000000021"),
            caption: caption(""),
          },
          {
            _: "pageBlockDocument",
            documentId: Long.fromString("5000000000000000010"),
            caption: caption("The plan"),
          },
          {
            _: "pageBlockAudio",
            audioId: Long.fromString("5000000000000000011"),
            caption: caption(""),
          },
          {
            _: "pageBlockMap",
            geo: {
              _: "geoPoint",
              lat: 41.9,
              long: 12.5,
              accessHash: Long.ZERO,
            },
            zoom: 14,
            w: 300,
            h: 200,
            caption: caption("Meeting point"),
          },
          {
            _: "pageBlockEmbed",
            url: "https://example.com/widget",
            caption: caption(""),
          },
          {
            _: "pageBlockEmbedPost",
            url: "https://example.com/post",
            webpageId: Long.ZERO,
            authorPhotoId: Long.ZERO,
            author: "Sam",
            date: 1_760_000_000,
            blocks: [paragraph("Quoted post")],
            caption: caption(""),
          },
          {
            _: "pageBlockChannel",
            channel: {
              _: "channel",
              id: 1_555_000_001,
              title: "Example News",
              username: "examplenews",
              photo: { _: "chatPhotoEmpty" },
              date: 1_760_000_000,
            },
          },
          {
            _: "pageBlockCover",
            cover: {
              _: "pageBlockPhoto",
              photoId: Long.fromString("5000000000000000022"),
              caption: caption(""),
            },
          },
          { _: "pageBlockUnsupported" },
        ],
        { documents: docs },
      ),
    ).toBe(
      [
        "[photo: Lake — Photo: Sam]",
        "[video]",
        "[document plan.pdf: The plan]",
        "[audio Band — Tune]",
        "[map 41.9, 12.5: Meeting point]",
        "[embed https://example.com/widget]",
        "[post Sam https://example.com/post]\n> Quoted post",
        "[channel: Example News @examplenews]",
        "[photo]",
        "[unsupported block]",
      ].join("\n\n"),
    );
  });

  it("writes collages and slideshows in their tags, with the caption", () => {
    const photo = (n: number) => {
      const result: tl.RawPageBlockPhoto = {
        _: "pageBlockPhoto",
        photoId: Long.fromNumber(n),
        caption: caption(""),
      };
      return result;
    };
    expect(
      render([
        {
          _: "pageBlockCollage",
          items: [photo(1), photo(2)],
          caption: caption("Trip"),
        },
        {
          _: "pageBlockSlideshow",
          items: [photo(3)],
          caption: caption(""),
        },
      ]),
    ).toBe(
      [
        "<tg-collage>",
        "",
        "[photo]",
        "[photo]",
        "<figcaption>Trip</figcaption>",
        "",
        "</tg-collage>",
        "",
        "<tg-slideshow>",
        "",
        "[photo]",
        "",
        "</tg-slideshow>",
      ].join("\n"),
    );
  });

  it("writes buttons, related articles and a thinking block", () => {
    expect(
      render([
        {
          _: "pageBlockButtonRow",
          buttons: [
            {
              _: "pageButton",
              text: plain("Site"),
              type: { _: "inlineButtonTypeUrl", url: "https://example.com/" },
            },
            {
              _: "pageButton",
              text: plain("Copy"),
              type: { _: "inlineButtonTypeCopy", copyText: "code-123" },
            },
          ],
        },
        {
          _: "pageBlockRelatedArticles",
          title: plain("Related"),
          articles: [
            {
              _: "pageRelatedArticle",
              url: "https://example.com/a",
              webpageId: Long.ZERO,
              title: "Article A",
            },
          ],
        },
        { _: "pageBlockThinking", text: plain("Working on it") },
      ]),
    ).toBe(
      [
        "[button: Site (https://example.com/)] [button: Copy]",
        "Related\n- [Article A](https://example.com/a)",
        "<tg-thinking>Working on it</tg-thinking>",
      ].join("\n\n"),
    );
  });

  it("reads a block type it does not know by its text or blocks, else names it", () => {
    const blocks = [
      { _: "pageBlockBanner", text: plain("Sale today") },
      {
        _: "pageBlockColumns",
        blocks: [paragraph("Left"), paragraph("Right")],
      },
      { _: "pageBlockHologram", id: 3 },
    ] as unknown as tl.TypePageBlock[];
    expect(render(blocks)).toBe("Sale today\n\nLeft\n\nRight\n\n[pageBlockHologram]");
  });
});

describe("richMessageText: input", () => {
  it("is null for a message without rich content and for anything else", () => {
    const plainMessage = {
      _: "message",
      id: 1,
      peerId,
      date: 1,
      message: "hi",
    };
    expect(richMessageText(plainMessage)).toBeNull();
    expect(richMessageText(toRawJson(plainMessage))).toBeNull();
    expect(richMessageText("{}")).toBeNull();
    expect(richMessageText('not json "richMessage"')).toBeNull();
    expect(richMessageText(null)).toBeNull();
    expect(richMessageText({ richMessage: { _: "somethingElse" } })).toBeNull();
    expect(render([])).toBeNull();
  });
});
