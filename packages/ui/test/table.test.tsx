import * as stylex from '@stylexjs/stylex';
import { afterEach, describe, expect, test } from 'vitest';
import { Pagination, pageWindow } from '../src/table/pagination';
import { tableSurface as surface } from '../src/table/surface';
import { Table } from '../src/table/table';
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

function Records({ interactive = false }: { interactive?: boolean } = {}) {
  return (
    <Table.Root interactive={interactive}>
      <Table.Head>
        <Table.Row>
          <Table.ColumnHeader>Session</Table.ColumnHeader>
          <Table.ColumnHeader numeric>Turns</Table.ColumnHeader>
        </Table.Row>
      </Table.Head>
      <Table.Body>
        <Table.Row>
          <Table.Cell>Worktree setup</Table.Cell>
          <Table.Cell numeric>12</Table.Cell>
        </Table.Row>
        <Table.Row selected>
          <Table.Cell>Review the diff</Table.Cell>
          <Table.Cell numeric>4</Table.Cell>
        </Table.Row>
      </Table.Body>
    </Table.Root>
  );
}

describe('Table', () => {
  test('a head row keeps its line and the last record does not', async () => {
    // The line is the one edge the rules give a list, and it goes to the *next*
    // row: under the head that is the first record, and under the last record
    // there is none. Only the body rows take the reading that can end.
    mounted = await mount(<Records />);
    const head = one('thead tr');
    const body = all('tbody tr');
    expect(carries(head, surface.row)).toBe(true);
    expect(carries(head, surface.bodyRow)).toBe(false);
    for (const row of body) expect(carries(row, surface.bodyRow)).toBe(true);
  });

  test('the pointer is answered only where pressing a row does something', async () => {
    // The package's first table lit every row on hover, and its one caller had
    // to turn that off again with a class. A table of facts is read, not
    // operated, so the hover is the table's decision and its default is off.
    mounted = await mount(<Records />);
    expect(carries(one('tbody tr'), surface.interactiveRow)).toBe(false);
    await mounted.unmount();

    mounted = await mount(<Records interactive />);
    expect(carries(one('tbody tr'), surface.interactiveRow)).toBe(true);
    // A head row is not a record, so it does not light up with them.
    expect(carries(one('thead tr'), surface.interactiveRow)).toBe(false);
  });

  test('a selected row is a fill and nothing it claims to a screen reader', async () => {
    // `aria-selected` belongs to a row in a grid. A table that lets a person
    // select rows puts a Checkbox in one, and that is what announces it.
    mounted = await mount(<Records interactive />);
    const selected = all('tbody tr')[1];
    expect(carries(selected, surface.selectedRow)).toBe(true);
    expect(selected.getAttribute('data-selected')).toBe('');
    expect(selected.hasAttribute('aria-selected')).toBe(false);
  });

  test('the size is stated once on the table and reaches every cell', async () => {
    // A row's height and a cell's padding are one decision. Stated per cell,
    // two of them could disagree inside one row.
    mounted = await mount(
      <Table.Root size="large">
        <Table.Body>
          <Table.Row>
            <Table.Cell>Worktree setup</Table.Cell>
          </Table.Row>
        </Table.Body>
      </Table.Root>
    );
    expect(one('table').getAttribute('data-size')).toBe('large');
    expect(carries(one('td'), surface.cellLarge)).toBe(true);
    expect(carries(one('td'), surface.cellMedium)).toBe(false);
  });

  test('figures are aligned to the end of their column without being told twice', async () => {
    // Numbers are read down a column rather than across a line, so a numeric
    // column takes tabular digits and the end of the column at once — and a
    // caller who wants one of those without the other still says so.
    mounted = await mount(<Records />);
    const [, turns] = all('tbody tr')[0].querySelectorAll('td');
    expect(carries(turns, surface.numeric, surface.alignEnd)).toBe(true);
    expect(carries(all('tbody tr')[0].querySelectorAll('td')[0], surface.alignStart)).toBe(true);
  });

  test('a column is only a control where the table can be ordered by it', async () => {
    const taken: string[] = [];
    mounted = await mount(
      <Table.Root>
        <Table.Head>
          <Table.Row>
            <Table.ColumnHeader>Session</Table.ColumnHeader>
            <Table.ColumnHeader
              sort="ascending"
              onSortChange={(next) => taken.push(`turns:${next}`)}
            >
              Turns
            </Table.ColumnHeader>
            <Table.ColumnHeader onSortChange={(next) => taken.push(`age:${next}`)}>
              Age
            </Table.ColumnHeader>
          </Table.Row>
        </Table.Head>
        <Table.Body />
      </Table.Root>
    );
    const [session, turns, age] = all('th');
    // A column with no way to take it says nothing about sorting at all; a
    // sortable one states the direction where a screen reader reads it.
    expect(session.hasAttribute('aria-sort')).toBe(false);
    expect(session.querySelector('button')).toBeNull();
    expect(turns.getAttribute('aria-sort')).toBe('ascending');
    expect(age.getAttribute('aria-sort')).toBe('none');
    // The arrow is the part's, so a sortable header cannot be assembled without
    // one — and the column that is not taken carries no arrow to misread.
    expect(turns.querySelector('svg')).not.toBeNull();
    expect(age.querySelector('svg')).toBeNull();

    // Taking the column that is already taken turns it over; taking a new one
    // starts ascending, because a person sorting by a name means A first.
    await click(turns.querySelector('button')!);
    await click(age.querySelector('button')!);
    expect(taken).toEqual(['turns:descending', 'age:ascending']);
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
