import Papa from 'papaparse';

const MAX_ROWS = 50_000;
const MAX_COLUMNS = 256;
const MAX_CELLS = 200_000;
const MAX_SEARCH_RESULTS = 2_000;

let rows: string[][] = [];

self.onmessage = (
  event: MessageEvent<
    { type: 'parse'; text: string; delimiter: string } | { type: 'search'; query: string }
  >
) => {
  const message = event.data;
  if (message.type === 'parse') {
    rows = [];
    let cellCount = 0;
    let truncated = false;
    Papa.parse<string[]>(message.text, {
      delimiter: message.delimiter,
      skipEmptyLines: 'greedy',
      step(result, parser) {
        const row = result.data.slice(0, MAX_COLUMNS);
        rows.push(row);
        cellCount += row.length;
        if (result.data.length > MAX_COLUMNS || rows.length >= MAX_ROWS || cellCount >= MAX_CELLS) {
          truncated = true;
          parser.abort();
        }
      },
      complete() {
        self.postMessage({ type: 'parsed', rows, truncated });
      },
      error(error: Error) {
        self.postMessage({ type: 'error', message: error.message });
      },
    });
    return;
  }

  const query = message.query.trim().toLocaleLowerCase();
  const matches: { row: number; col: number }[] = [];
  let total = 0;
  if (query) {
    for (let row = 0; row < rows.length; row += 1) {
      for (let col = 0; col < rows[row].length; col += 1) {
        if (rows[row][col]?.toLocaleLowerCase().includes(query)) {
          total += 1;
          if (matches.length < MAX_SEARCH_RESULTS) matches.push({ row, col });
        }
      }
    }
  }
  self.postMessage({ type: 'matches', query: message.query, matches, total });
};
