import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ExtraProps } from 'react-markdown';
import { writeTextToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';

const COPIED_FEEDBACK_MS = 1500;

/** One cell's text for a Markdown table: single line, pipes escaped. */
const markdownCellText = (cell: HTMLTableCellElement): string =>
  (cell.textContent ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
    .replace(/\|/g, '\\|');

/**
 * The table as GitHub-flavored Markdown: the first row is the header (as it is
 * in every Markdown-rendered table), then a delimiter row, then the body.
 */
export function tableToMarkdown(table: HTMLTableElement): string {
  const rows = Array.from(table.rows).map((row) => Array.from(row.cells).map(markdownCellText));
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, index) => cells[index] ?? '').join(' | ')} |`;
  const [header, ...body] = rows;
  return [line(header!), line(Array.from({ length: width }, () => '---')), ...body.map(line)].join(
    '\n'
  );
}

/**
 * Copies the table as HTML (spreadsheets and documents keep the cells) with a
 * Markdown fallback for plain-text targets; plain text only when the rich
 * clipboard API is unavailable.
 */
async function copyTable(table: HTMLTableElement): Promise<boolean> {
  const markdown = tableToMarkdown(table);
  if (!markdown) return false;
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([table.outerHTML], { type: 'text/html' }),
          'text/plain': new Blob([markdown], { type: 'text/plain' }),
        }),
      ]);
      return true;
    } catch {
      // Fall back to plain text below.
    }
  }
  return writeTextToClipboard(markdown);
}

type HastElement = NonNullable<ExtraProps['node']>;
type HastNode = HastElement['children'][number];

/**
 * A column whose longest cell measures at most this many ems (a CJK,
 * fullwidth or emoji character is one; a narrow one is ~0.55) stays on one
 * line; longer columns wrap. A single unbroken token wider than this marks
 * its column break-anywhere.
 */
export const MARKDOWN_TABLE_ONE_LINE_EM = 13;

/** A column's preferred width is capped here so a long cell cannot win it all. */
export const MARKDOWN_TABLE_MAX_COL_EM = 30;

/**
 * A column whose widest cell line exceeds this gets a higher minimum width,
 * so when even the minimums overflow the container it keeps a readable share
 * instead of collapsing to the flat floor.
 */
export const MARKDOWN_TABLE_WIDE_EM = 16;

const NARROW_EM = 0.55;
const CELL_PADDING_EM = 1.8;

const WIDE_CHARACTER =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Extended_Pictographic}/u;

const UNBROKEN_TOKEN_SEPARATOR = new RegExp(`\\s+|${WIDE_CHARACTER.source}`, 'u');

const segmentEm = (text: string): number => {
  let em = 0;
  for (const char of text.replace(/\s+/g, ' ').trim())
    em += WIDE_CHARACTER.test(char) ? 1 : NARROW_EM;
  return em;
};

const hastText = (node: HastNode): string => {
  if (node.type === 'text') return node.value;
  if (node.type !== 'element') return '';
  if (node.tagName === 'br') return '\n';
  // Replaced content has no measurable text in the hast: count it as one
  // long unbreakable token so its column gets a bounded preferred width.
  if (node.tagName === 'img' || node.tagName === 'video') return 'x'.repeat(40);
  return node.children.map(hastText).join('');
};

const childElements = (node: HastElement, tagNames: readonly string[]): HastElement[] =>
  node.children.filter(
    (child): child is HastElement => child.type === 'element' && tagNames.includes(child.tagName)
  );

export type MarkdownTableColumnLayout = {
  /** 1-based columns whose every cell fits on one short line. */
  oneLine: number[];
  /** 1-based columns holding a token too long to keep whole (hash, bare path). */
  breakAnywhere: number[];
  /** 1-based columns whose content is intrinsically wide. */
  wide: number[];
  /** Preferred column widths in em, 0-indexed; empty when the hast is absent. */
  widthsEm: number[];
};

/**
 * Classifies a GFM table's columns from its hast (a `<br>` splits a cell into
 * lines) and estimates each column's preferred width. GFM tables have no
 * spans, so a cell's position in its row is its column. The widths become
 * `<col>` elements: a specified column width is a preference the auto layout
 * honours exactly when there is room and shrinks toward min-content — in
 * proportion to how much it exceeds that minimum — when there is not.
 */
export function markdownTableColumnLayout(
  table: HastElement | undefined
): MarkdownTableColumnLayout {
  const widestLine: number[] = [];
  const widestToken: number[] = [];
  const rows = table
    ? childElements(table, ['thead', 'tbody', 'tfoot']).flatMap((section) =>
        childElements(section, ['tr'])
      )
    : [];
  for (const row of rows) {
    childElements(row, ['th', 'td']).forEach((cell, index) => {
      const text = hastText(cell);
      const line = Math.max(0, ...text.split('\n').map(segmentEm));
      // Wide characters are line-break opportunities of their own.
      const token = Math.max(0, ...text.split(UNBROKEN_TOKEN_SEPARATOR).map(segmentEm));
      widestLine[index] = Math.max(widestLine[index] ?? 0, line);
      widestToken[index] = Math.max(widestToken[index] ?? 0, token);
    });
  }
  const columnsWhere = (widths: number[], keep: (em: number) => boolean) =>
    widths.flatMap((em, index) => (keep(em) ? [index + 1] : []));
  return {
    oneLine: columnsWhere(widestLine, (em) => em <= MARKDOWN_TABLE_ONE_LINE_EM),
    breakAnywhere: columnsWhere(widestToken, (em) => em > MARKDOWN_TABLE_ONE_LINE_EM),
    wide: columnsWhere(widestLine, (em) => em > MARKDOWN_TABLE_WIDE_EM),
    widthsEm: widestLine.map((em) =>
      Math.min(MARKDOWN_TABLE_MAX_COL_EM, Math.ceil((em + CELL_PADDING_EM) * 2) / 2)
    ),
  };
}

type MarkdownTableProps = ComponentPropsWithoutRef<'table'> & ExtraProps;

/**
 * A Markdown table: a bordered, horizontally scrolling frame, as wide as its
 * content up to the available width, with a copy button in its top-right
 * corner (shown on hover or keyboard focus; always on touch screens). The
 * column classes from `markdownTableColumnLayout` are styled by
 * `.markdown-renderer [data-markdown-table]` in the Tailwind entry. Cell styling lives in the renderer's class list and makes no
 * assumption about the first row or column beyond the header row's band.
 */
export function MarkdownTable({ node, children, ...props }: MarkdownTableProps) {
  const { t } = useTranslation();
  const tableRef = useRef<HTMLTableElement>(null);
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    []
  );

  const handleCopy = async () => {
    const table = tableRef.current;
    if (!table || !(await copyTable(table))) return;
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  };

  const columns = markdownTableColumnLayout(node);
  const label = copied ? t('common.copied', 'Copied') : t('common.copyTable', 'Copy table');
  return (
    <div data-markdown-table-frame="" className="group/table relative my-3 w-fit max-w-full">
      <div
        data-markdown-table=""
        className="scrollbar-pro overflow-x-auto rounded-lg border border-foreground/[0.14] bg-background"
      >
        <table
          ref={tableRef}
          data-one-line-columns={columns.oneLine.join(' ')}
          data-break-anywhere-columns={columns.breakAnywhere.join(' ')}
          data-wide-columns={columns.wide.join(' ')}
          {...props}
        >
          {columns.widthsEm.length > 0 ? (
            <colgroup>
              {columns.widthsEm.map((em, index) => (
                <col key={index} style={{ width: `${em}em` }} />
              ))}
            </colgroup>
          ) : null}
          {children}
        </table>
      </div>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => {
          void handleCopy();
        }}
        className={cn(
          'absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-md border border-foreground/[0.1] bg-background/90 text-muted-foreground backdrop-blur-sm transition-opacity hover:text-foreground',
          'opacity-0 focus-visible:opacity-100 group-hover/table:opacity-100 [@media(hover:none)]:opacity-100',
          copied && 'opacity-100'
        )}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
