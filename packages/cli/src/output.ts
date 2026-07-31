import { getOutputFormat } from './config.js';

/**
 * Print data as an aligned table or JSON depending on user preference.
 */
export function printOutput(data: Record<string, unknown>[] | Record<string, unknown>, opts?: { forceJson?: boolean }): void {
  const format = opts?.forceJson ? 'json' : getOutputFormat();

  if (format === 'json') {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // Single object: print key-value pairs
  if (!Array.isArray(data)) {
    const entries = Object.entries(data);
    const maxKeyLen = Math.max(...entries.map(([k]) => k.length));
    for (const [key, value] of entries) {
      const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
      console.log(`${key.padEnd(maxKeyLen + 2)}${displayValue}`);
    }
    return;
  }

  // Array: print table
  if (data.length === 0) {
    console.log('(no results)');
    return;
  }

  const columns = Object.keys(data[0]);
  const widths: Record<string, number> = {};

  for (const col of columns) {
    widths[col] = col.length;
  }

  for (const row of data) {
    for (const col of columns) {
      const val = formatCell(row[col]);
      widths[col] = Math.max(widths[col], val.length);
    }
  }

  // Header
  const header = columns.map((c) => c.toUpperCase().padEnd(widths[c])).join('  ');
  console.log(header);
  console.log(columns.map((c) => '-'.repeat(widths[c])).join('  '));

  // Rows
  for (const row of data) {
    const line = columns.map((c) => formatCell(row[c]).padEnd(widths[c])).join('  ');
    console.log(line);
  }
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
