import * as stylex from '@stylexjs/stylex';
import { afterEach, describe, expect, test } from 'vitest';
import { Pagination, pageWindow } from '../src/table/pagination';
import { tableSurface as surface } from '../src/table/surface';
import { Table, type TableColumn, type TableSorting } from '../src/table/table';
import { all, classesOf, click, mount, one, press, step, typeInto, type Mounted } from './dom';

/** See `menu.test.tsx`: the same loosened call the primitives make. */
function classesFor(...styles: readonly unknown[]): string[] {
  const props = stylex.props as (...args: readonly unknown[]) => { className?: string };
  return (props(...styles).className ?? '').split(' ').filter(Boolean);
}

function carries(element: Element, ...styles: readonly unknown[]): boolean {
  const classes = classesOf(element);
  return classesFor(...styles).every((name) => classes.includes(name));
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

interface Session {
  id: string;
  name: string;
  agent: string;
  turns: number;
}

const SESSIONS: Session[] = [
  { id: 'a', name: 'Worktree setup', agent: 'Claude', turns: 12 },
  { id: 'b', name: 'Review the diff', agent: 'Codex', turns: 4 },
  { id: 'c', name: 'Rename the package', agent: 'Claude', turns: 31 },
];

const COLUMNS: TableColumn<Session>[] = [
  { key: 'name', header: 'Session', cell: (row) => row.name, width: 220 },
  { key: 'agent', header: 'Agent', cell: (row) => row.agent },
  { key: 'turns', header: 'Turns', cell: (row) => row.turns, numeric: true, sortable: true },
];

const key = (row: Session) => row.id;

describe('Table', () => {
  test('is ordered by one column at a time, and never reorders the rows itself', async () => {
    const taken: TableSorting[] = [];
    const sort: TableSorting = { column: 'turns', direction: 'ascending' };
    mounted = await mount(
      <Table
        columns={[...COLUMNS, { key: 'age', header: 'Age', cell: () => '2d', sortable: true }]}
        rows={SESSIONS}
        rowKey={key}
        sort={sort}
        onSortChange={(next) => taken.push(next)}
        // Stacking is what puts a column's name inside its own cells; this test
        // is about the order of the rows, so it reads them as plain columns.
        stack={false}
      />
    );
    const [name, agent, turns, age] = all('th');
    // A column with no way to take it says nothing about sorting at all; a
    // sortable one states the direction where a screen reader reads it, and
    // only one column can be the one wearing the arrow.
    expect(name.hasAttribute('aria-sort')).toBe(false);
    expect(agent.hasAttribute('aria-sort')).toBe(false);
    expect(turns.getAttribute('aria-sort')).toBe('ascending');
    expect(age.getAttribute('aria-sort')).toBe('none');
    expect(turns.querySelector('svg')).not.toBeNull();
    expect(age.querySelector('svg')).toBeNull();

    // Taking the column that is already taken turns it over; taking a new one
    // starts ascending, because a person sorting by a name means A first.
    await click(turns.querySelector('button')!);
    await click(age.querySelector('button')!);
    expect(taken).toEqual([
      { column: 'turns', direction: 'descending' },
      { column: 'age', direction: 'ascending' },
    ]);

    // The rows are the surface's: a server sorts, a comparator breaks ties, a
    // page is one slice of many. The table owns the control, not the data.
    expect(all('tbody tr').map((row) => row.querySelector('td')?.textContent)).toEqual([
      'Worktree setup',
      'Review the diff',
      'Rename the package',
    ]);
  });

  test('derives the box that takes every row, mixed state and all', async () => {
    const taken: string[][] = [];
    const render = (selected: string[]) => (
      <Table
        columns={COLUMNS}
        rows={SESSIONS}
        rowKey={key}
        selected={selected}
        onSelectedChange={(next) => taken.push(next)}
        rowLabel={(row) => `Select ${row.name}`}
      />
    );

    mounted = await mount(render([]));
    const head = () => one('thead [role="checkbox"]');
    expect(head().getAttribute('aria-checked')).toBe('false');
    // A table that lets a person pick rows puts a box in one, because that is
    // both what they press and what a screen reader is told about.
    expect(all('tbody [role="checkbox"]')).toHaveLength(3);
    expect(all('tbody [role="checkbox"]')[0].getAttribute('aria-label')).toBe(
      'Select Worktree setup'
    );
    await click(head());
    expect(taken).toEqual([['a', 'b', 'c']]);
    await mounted.unmount();

    mounted = await mount(render(['b']));
    // Some, not all: the head says mixed rather than picking a side.
    expect(head().getAttribute('aria-checked')).toBe('mixed');
    expect(carries(all('tbody tr')[1], surface.selectedRow)).toBe(true);
    expect(carries(all('tbody tr')[0], surface.selectedRow)).toBe(false);
    await mounted.unmount();

    mounted = await mount(render(['a', 'b', 'c']));
    expect(head().getAttribute('aria-checked')).toBe('true');
    await click(head());
    // All of them held, so pressing it clears them.
    expect(taken.at(-1)).toEqual([]);
  });

  test('a selection reaching past the rows on screen survives a select-all', async () => {
    // The box in the head answers for the rows it is showing. A table holding
    // one page of a long selection must not drop the pages already taken.
    const taken: string[][] = [];
    mounted = await mount(
      <Table
        columns={COLUMNS}
        rows={SESSIONS.slice(0, 2)}
        rowKey={key}
        selected={['z']}
        onSelectedChange={(next) => taken.push(next)}
      />
    );
    await click(one('thead [role="checkbox"]'));
    expect(taken).toEqual([['z', 'a', 'b']]);
  });

  test('says there is nothing across every column, and keeps the names', async () => {
    mounted = await mount(
      <Table
        columns={COLUMNS}
        rows={[]}
        rowKey={key}
        selected={[]}
        onSelectedChange={() => {}}
        empty="No sessions yet"
      />
    );
    // Only the table knows how many columns to cross, and the selection column
    // is one of them. The head stays, so a person can read what was coming.
    expect(one('tbody td').getAttribute('colspan')).toBe('4');
    expect(one('tbody td').textContent).toBe('No sessions yet');
    expect(all('th')).toHaveLength(3);
  });

  test('a row that can be pressed takes the keyboard, and the box in it keeps its own press', async () => {
    const opened: string[] = [];
    const picked: string[][] = [];
    mounted = await mount(
      <Table
        columns={COLUMNS}
        rows={SESSIONS}
        rowKey={key}
        selected={[]}
        onSelectedChange={(next) => picked.push(next)}
        onRowPress={(row) => opened.push(row.id)}
      />
    );
    const rows = all('tbody tr');
    expect(rows[0].getAttribute('tabindex')).toBe('0');
    await click(rows[0]);
    expect(opened).toEqual(['a']);

    // Enter and Space press the row the way they press the button it stands for.
    await step(() => rows[1].focus());
    await press('Enter');
    await step(() => rows[2].focus());
    await press(' ');
    expect(opened).toEqual(['a', 'b', 'c']);

    // Opening a record and picking it are two actions in one row.
    await click(all('tbody [role="checkbox"]')[0]);
    expect(picked).toEqual([['a']]);
    expect(opened).toEqual(['a', 'b', 'c']);
  });

  test('a table of facts takes no pointer and no tab stop', async () => {
    // The package's first table lit every row on hover, and its one caller had
    // to turn that off again with a class. A table is read, not operated,
    // unless pressing a row does something.
    mounted = await mount(<Table columns={COLUMNS} rows={SESSIONS} rowKey={key} />);
    const row = one('tbody tr');
    expect(row.hasAttribute('tabindex')).toBe(false);
    expect(carries(row, surface.hoverRow)).toBe(false);
    expect(carries(row, surface.pressableRow)).toBe(false);
  });
});

describe('pageWindow', () => {
  const width = (page: number, pages: number) => pageWindow(page, pages, 1, 1).length;

  test('stays one width from the first page to the last', () => {
    // A pager that grew and shrank as a person walked through it would move the
    // buttons out from under the pointer.
    const widths = new Set(Array.from({ length: 40 }, (_, index) => width(index + 1, 40)));
    expect([...widths]).toEqual([7]);
  });

  test('always offers the page you are on, the first and the last', () => {
    for (let page = 1; page <= 40; page += 1) {
      const listed = pageWindow(page, 40, 1, 1);
      expect(listed, `page ${page}`).toContain(page);
      expect(listed).toContain(1);
      expect(listed).toContain(40);
    }
  });

  test('never hides a single page behind a gap', () => {
    // A gap is wider than the page it would hide, and costs the press that page
    // would have taken.
    for (let page = 1; page <= 40; page += 1) {
      const listed = pageWindow(page, 40, 1, 1);
      listed.forEach((entry, index) => {
        if (entry !== 'gap') return;
        const before = listed[index - 1];
        const after = listed[index + 1];
        expect(typeof before === 'number' && typeof after === 'number').toBe(true);
        expect((after as number) - (before as number), `page ${page}`).toBeGreaterThan(2);
      });
    }
  });
});

describe('Pagination', () => {
  test('a page outside the range is brought back into it', async () => {
    const taken: number[] = [];
    mounted = await mount(
      <Pagination page={99} pages={5} onPageChange={(page) => taken.push(page)} />
    );
    expect(one('[aria-current="page"]').textContent).toBe('5');
    // It is the last page, so there is no next one to offer.
    expect(one('[aria-label="Next page"]').hasAttribute('disabled')).toBe(true);
    await click(one('[aria-label="Previous page"]'));
    expect(taken).toEqual([4]);
  });

  test('the compact layout says where you are in a sentence, not in slashes', async () => {
    mounted = await mount(
      <Pagination layout="compact" page={4} pages={120} onPageChange={() => {}} />
    );
    // What is on screen is "4 / 120", which is read as "4 slash 120"; the
    // sentence beside it is what a screen reader is given instead.
    expect(one('nav').textContent).toContain('Page 4 of 120');
    expect(all('nav li button')).toHaveLength(0);
    expect(one('nav').textContent).toContain('/ 120');
  });

  test('a typed page is taken when it is finished, not while it is typed', async () => {
    // Typing 4-5 through a pager that navigates as you type visits page 4 on
    // the way to page 45 — and over a large file that is a page fetched and
    // thrown away.
    const taken: number[] = [];
    mounted = await mount(
      <Pagination
        layout="compact"
        jump
        page={1}
        pages={120}
        onPageChange={(page) => taken.push(page)}
      />
    );
    const field = one('input') as HTMLInputElement;
    expect(field.getAttribute('aria-label')).toBe('Page');
    await step(() => field.focus());
    await typeInto(field, '4');
    await typeInto(field, '45');
    expect(taken).toEqual([]);
    await press('Enter');
    expect(taken).toEqual([45]);

    // Leaving the field commits it too, and a page past the end lands on it.
    await step(() => field.focus());
    await typeInto(field, '900');
    await step(() => field.blur());
    expect(taken).toEqual([45, 120]);
  });
});
