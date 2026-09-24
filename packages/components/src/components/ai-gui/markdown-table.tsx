import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { writeTextToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';

const COPIED_FEEDBACK_MS = 1500;

/** One cell's text for a Markdown table: single line, pipes escaped. */
const markdownCellText = (cell: HTMLTableCellElement): string =>
  (cell.textContent ?? '').replace(/\s*\n\s*/g, ' ').trim().replace(/\|/g, '\\|');

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

type MarkdownTableProps = ComponentPropsWithoutRef<'table'> & { node?: unknown };

/**
 * A Markdown table: a bordered, horizontally scrolling frame with a copy
 * button in its top-right corner (shown on hover or keyboard focus; always on
 * touch screens). Cell styling lives in the renderer's class list and makes no
 * assumption about the first row or column beyond the header row's band.
 */
export function MarkdownTable({ node: _node, ...props }: MarkdownTableProps) {
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

  const label = copied ? t('common.copied', 'Copied') : t('common.copyTable', 'Copy table');
  return (
    <div data-markdown-table-frame="" className="group/table relative my-3">
      <div
        data-markdown-table=""
        className="scrollbar-pro overflow-x-auto rounded-lg border border-foreground/[0.14] bg-background"
      >
        <table ref={tableRef} {...props} />
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
