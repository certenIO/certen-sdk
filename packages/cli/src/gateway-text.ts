/**
 * Text that came from the gateway, or from the validators through it, made safe to put on a terminal.
 *
 * A transaction hash, a note, an explorer link or a refusal message is written by a server and shown next to what the person is about to
 * decide. A control character in it can move the cursor, clear a line or repaint what was just printed, so it is stripped (the same rule
 * `pending`'s memo follows). Nothing here changes what a plain value looks like: a hash or a link passes through as it is.
 */
export function printable(value: unknown, max = 300): string {
  const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  // C0 (including tab, CR and LF), DEL and C1 controls become one space each run, so one value stays on one line.
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * A decimal money string as the gateway wrote it, with a dollar sign and without the zeros it padded to six places (`0.350000` is $0.35).
 *
 * Not `usd()`: that rounds to cents, which is right for an account balance and wrong for an estimate of what a testnet transaction costs, where
 * `0.004` rounded to `$0.00` would read as free. A value that is not a plain decimal is shown as given.
 */
export function dollars(amount: unknown): string {
  const raw = typeof amount === 'string' ? amount.trim() : typeof amount === 'number' ? String(amount) : '';
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!m) return printable(raw) || 'unknown';
  const frac = (m[3] ?? '').replace(/0+$/, '').padEnd(2, '0');
  return `${m[1]}$${m[2]}.${frac}`;
}
