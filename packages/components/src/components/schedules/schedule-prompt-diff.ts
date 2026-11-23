export type PromptDiffLine = { kind: 'same' | 'add' | 'del' | 'gap'; text: string };

const MAX_CELLS = 4_000_000;

/**
 * Line diff of a schedule prompt. Unchanged runs keep `context` lines beside each
 * change and collapse the rest into one `gap`; `null` when too long to compare.
 *
 * shortcut: the table is lines × lines, so very long prompts get no diff; use a
 * linear-space diff if that matters.
 */
export function diffPromptLines(
  before: string,
  after: string,
  context = 2
): PromptDiffLine[] | null {
  const a = before.split('\n');
  const b = after.split('\n');
  const width = b.length + 1;
  if ((a.length + 1) * width > MAX_CELLS) return null;
  const lcs = new Uint16Array((a.length + 1) * width);
  const at = (i: number, j: number) => lcs[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const lines: PromptDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i] ?? '' });
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && at(i + 1, j) >= at(i, j + 1)))
      lines.push({ kind: 'del', text: a[i++] ?? '' });
    else lines.push({ kind: 'add', text: b[j++] ?? '' });
  }
  const keep = lines.map((_, index) =>
    lines.slice(Math.max(0, index - context), index + context + 1).some((l) => l.kind !== 'same')
  );
  return lines.flatMap((line, index) =>
    keep[index] ? [line] : keep[index - 1] === false ? [] : [{ kind: 'gap', text: '' }]
  );
}
