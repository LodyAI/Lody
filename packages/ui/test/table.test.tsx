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
  test('states each column once, so a head and a row cannot drift', async () => {
    // The whole of the design: a column is one object, and the name in the head
    // and the cell under it are two readings of it. The two surfaces in this
    // repository that draw a table today write their column template twice, by
    // hand, and one of them writes every cell a second time.
    mounted = await mount(<Table columns={COLUMNS} rows={SESSIONS} rowKey={key} />);
    const headers = all('th').map((cell) => cell.textContent);
    expect(headers).toEqual(['Session', 'Agent', 'Turns']);
    for (const row of all('tbody tr')) {
      expect(row.querySelectorAll('td')).toHaveLength(COLUMNS.length);
    }
    // A width is stated on a `<col>`, so the name and every cell under it take
    // it from one place — the cells being ones the caller never writes.
    expect(all('col')).toHaveLength(COLUMNS.length);
    expect(one('col').getAttribute('style')).toContain('220px');
  });

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

  test('a head stays only where the table owns a box to stay in', async () => {
    // A head that scrolls out of its own box is not a thing a surface asks for,
    // so the height and the sticky head are one decision rather than two props.
    mounted = await mount(<Table columns={COLUMNS} rows={SESSIONS} rowKey={key} />);
    expect(carries(one('thead'), surface.headSticky)).toBe(false);
    await mounted.unmount();

    mounted = await mount(<Table columns={COLUMNS} rows={SESSIONS} rowKey={key} maxHeight={240} />);
    expect(carries(one('thead'), surface.headSticky)).toBe(true);
    // A head that stays is a band over the rows, so it takes a rung: without a
    // fill the records are painted through the column names.
    expect(carries(one('thead tr'), surface.headStickyRow)).toBe(true);
    expect(one('table').parentElement?.getAttribute('style')).toContain('240px');
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

  test('the last record draws no line to a next row there is none of', async () => {
    mounted = await mount(<Table columns={COLUMNS} rows={SESSIONS} rowKey={key} />);
    const rows = all('tbody tr');
    expect(carries(rows.at(-1)!, surface.bodyRowLast)).toBe(true);
    // And every row before it draws one. A table that renders its own rows says
    // which is last instead of reading `:last-child`, so the line it draws has
    // to be stated too — the board caught this one as three rows with no line.
    expect(carries(rows[0], surface.bodyRowLined)).toBe(true);
    expect(carries(rows.at(-1)!, surface.bodyRowLined)).toBe(false);
    // The head keeps its line: the row after it is the first record.
    expect(carries(one('thead tr'), surface.headRow)).toBe(true);
  });

  test('draws a totals row only where a column says what goes in it', async () => {
    mounted = await mount(<Table columns={COLUMNS} rows={SESSIONS} rowKey={key} />);
    expect(document.querySelector('tfoot')).toBeNull();
    await mounted.unmount();

    mounted = await mount(
      <Table
        columns={COLUMNS.map((column) =>
          column.key === 'turns' ? { ...column, footer: 47 } : column
        )}
        rows={SESSIONS}
        rowKey={key}
      />
    );
    expect(one('tfoot').textContent).toContain('47');
  });

  test('a table too narrow for its columns becomes a stack of records', async () => {
    // Every surface in this repository that draws a table today collapses on a
    // narrow window by hand, and one of them renders every cell a second time
    // to do it. The labels here are the head's own words, which is only
    // reachable because the columns were stated — and the question is about the
    // table's own box rather than the window, so a table in a narrow panel
    // stacks on a wide screen.
    mounted = await mount(<Table columns={COLUMNS} rows={SESSIONS} rowKey={key} />);
    expect(carries(one('thead'), surface.stackedHead)).toBe(true);
    expect(carries(one('tbody tr'), surface.stackedRow)).toBe(true);
    const labelled = one('tbody td');
    expect(carries(labelled, surface.stackedCell)).toBe(true);
    expect(labelled.textContent).toBe('SessionWorktree setup');
    await mounted.unmount();

    // A table whose columns must stay a grid says so, and keeps the scrollbar.
    mounted = await mount(<Table columns={COLUMNS} rows={SESSIONS} rowKey={key} stack={false} />);
    expect(carries(one('thead'), surface.stackedHead)).toBe(false);
    expect(carries(one('tbody tr'), surface.stackedRow)).toBe(false);
    expect(one('tbody td').textContent).toBe('Worktree setup');
  });

  test('the parts are there for a table that is not a list of records', async () => {
    // A two-column list of facts is not a list of records, and the elements are
    // exported for exactly that: the onboarding summary reads its labels as row
    // headers rather than as a column with a name of its own.
    mounted = await mount(
      <Table.Root size="large">
        <Table.Body>
          <Table.Row>
            <Table.ColumnHeader scope="row">Agent</Table.ColumnHeader>
            <Table.Cell>Claude</Table.Cell>
          </Table.Row>
        </Table.Body>
      </Table.Root>
    );
    expect(one('th').getAttribute('scope')).toBe('row');
    expect(carries(one('td'), surface.cellLarge)).toBe(true);
    // A row a caller assembled reads its own position, because it has no table
    // above it counting the rows.
    expect(carries(one('tbody tr'), surface.bodyRow)).toBe(true);
  });

  test('figures are aligned to the end of their column without being told twice', async () => {
    mounted = await mount(<Table columns={COLUMNS} rows={SESSIONS} rowKey={key} />);
    const cells = all('tbody tr')[0].querySelectorAll('td');
    expect(carries(cells[2], surface.numeric, surface.alignEnd)).toBe(true);
    expect(carries(cells[0], surface.alignStart)).toBe(true);
    // And the name of a numeric column goes with them, which is the thing a
    // caller writing the head and the body separately forgets.
    expect(carries(all('th')[2], surface.numeric, surface.alignEnd)).toBe(true);
  });

  test('a value is one line unless the column holds sentences', async () => {
    mounted = await mount(
      <Table
        columns={[
          COLUMNS[0],
          { key: 'note', header: 'Note', cell: () => 'a sentence', wrap: true },
        ]}
        rows={SESSIONS}
        rowKey={key}
      />
    );
    const cells = all('tbody tr')[0].querySelectorAll('td');
    expect(carries(cells[0], surface.cellWrap)).toBe(false);
    expect(carries(cells[1], surface.cellWrap)).toBe(true);
  });
});

describe('pageWindow', () => {
  const width = (page: number, pages: number) => pageWindow(page, pages, 1, 1).length;

  test('lists every page while they all fit', () => {
    expect(pageWindow(1, 7, 1, 1)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pageWindow(4, 1, 1, 1)).toEqual([1]);
  });

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

  test('spends the gap it does not need on more pages', () => {
    expect(pageWindow(1, 40, 1, 1)).toEqual([1, 2, 3, 4, 5, 'gap', 40]);
    expect(pageWindow(40, 40, 1, 1)).toEqual([1, 'gap', 36, 37, 38, 39, 40]);
    expect(pageWindow(20, 40, 1, 1)).toEqual([1, 'gap', 19, 20, 21, 'gap', 40]);
  });

  test('widens with the siblings and the boundaries it is given', () => {
    expect(pageWindow(20, 40, 2, 2)).toEqual([1, 2, 'gap', 18, 19, 20, 21, 22, 'gap', 39, 40]);
  });
});

describe('Pagination', () => {
  test('the page you are on says so twice, and the ends stop', async () => {
    const taken: number[] = [];
    mounted = await mount(
      <Pagination page={1} pages={5} onPageChange={(page) => taken.push(page)} />
    );
    // Once as a fill, and once as `aria-current` — the fill reaches only the
    // people who can see it.
    const current = one('[aria-current="page"]');
    expect(current.textContent).toBe('1');
    expect(current.getAttribute('data-variant')).toBe('secondary');
    expect(one('[aria-label="Previous page"]').hasAttribute('disabled')).toBe(true);
    expect(one('[aria-label="Next page"]').hasAttribute('disabled')).toBe(false);

    await click(one('[aria-label="Page 3"]'));
    await click(one('[aria-label="Next page"]'));
    expect(taken).toEqual([3, 2]);
  });

  test('the gaps name no page a person can go to', async () => {
    // A list that reads "3, 4, more pages, 98" says nothing "3, 4, 98" does
    // not, so the gap is hidden rather than given a sentence of its own.
    mounted = await mount(<Pagination page={20} pages={40} onPageChange={() => {}} />);
    const gaps = all('li[aria-hidden="true"]');
    expect(gaps).toHaveLength(2);
    expect(all('nav li button')).toHaveLength(5);
    expect(one('nav').getAttribute('aria-label')).toBe('Pagination');
  });

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
