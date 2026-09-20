/**
 * src/lib/docxRender.ts
 * ---------------------------------------------------------------------------
 * Markdown -> a real Word document.
 *
 * REQUIRES ONE INSTALL:   npm install docx
 *
 * PDF generation needs nothing new — `marked` and `puppeteer` are already in
 * package.json. DOCX does, and the dependency is a hard one: an earlier draft
 * imported `docx` dynamically inside a try/catch so a missing package would
 * "degrade gracefully", which does not work. `await import("docx")` with a
 * literal specifier is resolved by the bundler at build time and
 * `typeof import("docx")` is resolved by tsc, so a missing package fails
 * `next build` rather than throwing somewhere a catch could see it — and since
 * the route imports this module, that would have taken PDF down with it. A
 * plain static import is honest about the requirement and keeps full type
 * checking on the API calls below.
 *
 * WHY NOT JUST RENAME AN .html TO .doc
 *
 * Word will open it, then show a "the file format doesn't match" warning, lose
 * styles on round-trip, and produce a file that no other tool can parse. A
 * genuine OOXML document is worth the one dependency.
 *
 * The block parser below is intentionally small and separate from the docx API
 * — it produces plain data, so it can be reused (and eyeballed) independently
 * of how it is rendered.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

/* -------------------------------------------------------------------------
 * Markdown model
 * ---------------------------------------------------------------------- */

export interface Inline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: string;
}

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; lines: string[]; lang: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "hr" }
  | { kind: "table"; header: string[]; rows: string[][] };

/**
 * Inline formatting.
 *
 * Deliberately handles `*` and `**` but NOT `_` and `__`. In a tool whose
 * output is mostly code, `_` appears constantly in identifiers, and treating
 * `snake_case_name` as italics mangles far more text than underscore emphasis
 * would ever have styled correctly.
 */
export function parseInline(input: string): Inline[] {
  const runs: Inline[] = [];
  const pattern =
    /\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|~~(.+?)~~|\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;

  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input)) !== null) {
    if (match.index > cursor) {
      runs.push({ text: input.slice(cursor, match.index) });
    }

    if (match[1] !== undefined) runs.push({ text: match[1], bold: true });
    else if (match[2] !== undefined)
      runs.push({ text: match[2], italic: true });
    else if (match[3] !== undefined) runs.push({ text: match[3], code: true });
    else if (match[4] !== undefined)
      runs.push({ text: match[4], strike: true });
    else if (match[5] !== undefined) {
      runs.push({ text: match[5] || match[6], link: match[6] });
    }

    cursor = match.index + match[0].length;
  }

  if (cursor < input.length) runs.push({ text: input.slice(cursor) });
  return runs.length > 0 ? runs : [{ text: input }];
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");
}

/* One definition per block opener, shared by the dispatcher below and by the
 * paragraph loop's stop condition. When these two lists disagree, whatever the
 * paragraph loop forgets gets swallowed into the preceding paragraph — that is
 * how an early draft ate tables and horizontal rules that were not preceded by
 * a blank line. `-` sits first inside each class so it is never read as a range. */
const FENCE_RE = /^\s*```/;
const HR_RE = /^\s*([-*_])\s*\1\s*\1[-\s*_]*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
const QUOTE_RE = /^\s*>/;
const UL_RE = /^\s*[-*+]\s+/;
const OL_RE = /^\s*\d+[.)]\s+/;

function isTableStart(lines: string[], index: number): boolean {
  return (
    lines[index].includes("|") &&
    index + 1 < lines.length &&
    isTableDivider(lines[index + 1])
  );
}

/** True if the line at `index` opens a block, i.e. ends any open paragraph. */
function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index];
  return (
    !line.trim() ||
    FENCE_RE.test(line) ||
    HR_RE.test(line) ||
    HEADING_RE.test(line) ||
    QUOTE_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line) ||
    isTableStart(lines, index)
  );
}

/**
 * Block-level parser.
 *
 * Nested lists are flattened to a single level. Word's numbering model makes
 * arbitrary nesting a much larger job, and flat lists read correctly; deep
 * nesting is rare in generated documents.
 */
export function parseMarkdownBlocks(markdown: string): Block[] {
  const lines = String(markdown ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const blocks: Block[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    /* Fenced code — consumed verbatim, no inline parsing inside. */
    const fence = line.match(/^\s*```+\s*(\S*)/);
    if (fence) {
      const lang = fence[1] || "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; /* closing fence */
      blocks.push({ kind: "code", lines: body, lang });
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        text: heading[2].replace(/\s+#+\s*$/, "").trim(),
      });
      i++;
      continue;
    }

    /* Table: a pipe row immediately followed by a divider row. */
    if (isTableStart(lines, i)) {
      const header = splitTableRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", lines: quoted });
      continue;
    }

    if (UL_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && UL_RE.test(lines[i])) {
        items.push(lines[i].replace(UL_RE, "").trim());
        i++;
      }
      blocks.push({ kind: "list", ordered: false, items });
      continue;
    }

    if (OL_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && OL_RE.test(lines[i])) {
        items.push(lines[i].replace(OL_RE, "").trim());
        i++;
      }
      blocks.push({ kind: "list", ordered: true, items });
      continue;
    }

    /* Paragraph: runs until something else opens a block. Reaching this point
     * means `startsBlock(lines, i)` is false for the current line, so the loop
     * always consumes at least one line and `i` always advances. */
    const paragraph: string[] = [];
    while (i < lines.length && !startsBlock(lines, i)) {
      paragraph.push(lines[i].trim());
      i++;
    }
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    } else {
      i++; /* Defensive: unreachable, but never spin. */
    }
  }

  return blocks;
}

/* -------------------------------------------------------------------------
 * Blocks -> DOCX
 * ---------------------------------------------------------------------- */

const ORDERED_REF = "omniroute-ordered";
const MONO = "Consolas";
const BODY_FONT = "Calibri";

/**
 * Render markdown as a .docx buffer.
 */
export async function renderDocx(
  markdown: string,
  title: string,
): Promise<Buffer> {
  const headingFor = (level: number) =>
    level === 1
      ? HeadingLevel.HEADING_1
      : level === 2
        ? HeadingLevel.HEADING_2
        : level === 3
          ? HeadingLevel.HEADING_3
          : level === 4
            ? HeadingLevel.HEADING_4
            : level === 5
              ? HeadingLevel.HEADING_5
              : HeadingLevel.HEADING_6;

  /** Inline runs -> docx runs, keeping links clickable. */
  const runsFor = (
    text: string,
  ): (
    | InstanceType<typeof TextRun>
    | InstanceType<typeof ExternalHyperlink>
  )[] =>
    parseInline(text).map((run) => {
      if (run.link) {
        return new ExternalHyperlink({
          link: run.link,
          children: [new TextRun({ text: run.text, style: "Hyperlink" })],
        });
      }
      return new TextRun({
        text: run.text,
        bold: run.bold,
        italics: run.italic,
        strike: run.strike,
        font: run.code ? MONO : BODY_FONT,
        ...(run.code ? { color: "9A3412", size: 20 } : {}),
      });
    });

  const children: (
    | InstanceType<typeof Paragraph>
    | InstanceType<typeof Table>
  )[] = [
    new Paragraph({
      children: [
        new TextRun({ text: title, bold: true, size: 44, font: BODY_FONT }),
      ],
      spacing: { after: 80 },
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: new Date().toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
          }),
          color: "64748B",
          size: 17,
          font: BODY_FONT,
        }),
      ],
      border: {
        bottom: {
          style: BorderStyle.SINGLE,
          size: 12,
          color: "0F172A",
          space: 6,
        },
      },
      spacing: { after: 320 },
    }),
  ];

  for (const block of parseMarkdownBlocks(markdown)) {
    switch (block.kind) {
      case "heading":
        children.push(
          new Paragraph({
            heading: headingFor(block.level),
            children: runsFor(block.text),
            spacing: { before: 280, after: 120 },
            keepNext: true,
          }),
        );
        break;

      case "paragraph":
        children.push(
          new Paragraph({
            children: runsFor(block.text),
            spacing: { after: 160 },
          }),
        );
        break;

      case "code":
        block.lines.forEach((codeLine, index) => {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: codeLine || " ",
                  font: MONO,
                  size: 18,
                  color: "0F172A",
                }),
              ],
              border: {
                left: {
                  style: BorderStyle.SINGLE,
                  size: 18,
                  color: "CBD5E1",
                  space: 10,
                },
              },
              spacing: {
                before: index === 0 ? 120 : 0,
                after: index === block.lines.length - 1 ? 180 : 0,
                line: 240,
              },
            }),
          );
        });
        break;

      case "list":
        block.items.forEach((item) => {
          children.push(
            new Paragraph({
              children: runsFor(item),
              spacing: { after: 60 },
              ...(block.ordered
                ? { numbering: { reference: ORDERED_REF, level: 0 } }
                : { bullet: { level: 0 } }),
            }),
          );
        });
        break;

      case "quote":
        children.push(
          new Paragraph({
            children: runsFor(block.lines.join(" ")),
            indent: { left: 360 },
            border: {
              left: {
                style: BorderStyle.SINGLE,
                size: 18,
                color: "CBD5E1",
                space: 10,
              },
            },
            spacing: { before: 120, after: 180 },
          }),
        );
        break;

      case "hr":
        children.push(
          new Paragraph({
            text: "",
            border: {
              bottom: {
                style: BorderStyle.SINGLE,
                size: 6,
                color: "E2E8F0",
                space: 1,
              },
            },
            spacing: { before: 200, after: 200 },
          }),
        );
        break;

      case "table": {
        const headerRow = new TableRow({
          tableHeader: true,
          children: block.header.map(
            (cell) =>
              new TableCell({
                shading: { fill: "F1F5F9" },
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({ text: cell, bold: true, font: BODY_FONT }),
                    ],
                  }),
                ],
              }),
          ),
        });

        const bodyRows = block.rows.map(
          (row) =>
            new TableRow({
              children: block.header.map(
                (_, columnIndex) =>
                  new TableCell({
                    children: [
                      new Paragraph({
                        children: runsFor(row[columnIndex] ?? ""),
                      }),
                    ],
                  }),
              ),
            }),
        );

        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [headerRow, ...bodyRows],
          }),
        );
        children.push(new Paragraph({ text: "", spacing: { after: 160 } }));
        break;
      }
    }
  }

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: ORDERED_REF,
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.LEFT,
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1134, right: 1021, bottom: 1247, left: 1021 },
          },
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc) as unknown as Promise<Buffer>;
}
