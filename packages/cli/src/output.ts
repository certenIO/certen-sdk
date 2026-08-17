import { CertenPaymentRequiredError } from '@certen.io/sdk';
import { getOutputFormat } from './config.js';
import { CliError, EXIT, type ExitCode } from './errors.js';

/**
 * Two output modes with different audiences and different guarantees.
 *
 * Table mode is for humans and is NOT a contract — column widths and wording may change.
 *
 * JSON mode is a machine contract: exactly one envelope object on stdout and nothing else, every
 * human-facing line on stderr, and an exit code that says which kind of failure occurred. See
 * docs/CLI-CONTRACT.md. The single-object guarantee is why payloads are buffered rather than
 * printed as they arrive: a command that prints twice would otherwise emit two top-level objects
 * and break every streaming JSON parser pointed at it.
 */

let jsonMode = false;
/** Payloads collected in JSON mode, flushed as one envelope when the command finishes. */
let collected: unknown[] = [];
let flushed = false;

export function setJsonMode(on: boolean): void {
  jsonMode = on;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/** Test seam: reset module state between cases. */
export function resetOutput(): void {
  jsonMode = false;
  collected = [];
  flushed = false;
}

/**
 * Print a result. In JSON mode this buffers; call `flushSuccess()` once the command completes.
 */
export function printOutput(
  data: Record<string, unknown>[] | Record<string, unknown>,
  opts?: {
    forceJson?: boolean;
    /**
     * Emit for machines only, and print nothing in table mode.
     *
     * For a command that renders its own readable summary. Without this the payload and the summary
     * both reach a person, so every figure appears twice — and any long or nested field (a payment
     * URI, a credit object) lands in the middle of the instructions someone is trying to follow.
     */
    machineOnly?: boolean;
  },
): void {
  if (jsonMode) {
    collected.push(data);
    return;
  }

  const format = opts?.forceJson ? 'json' : getOutputFormat();
  if (format === 'json') {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (opts?.machineOnly) return;
  printTable(data);
}

/**
 * A human-facing note — "API key saved", "(no keys)".
 *
 * In JSON mode this goes to stderr, because stdout is reserved for the single envelope. In table
 * mode it is ordinary output and goes to stdout.
 */
export function human(message: string): void {
  if (jsonMode) console.error(message);
  else console.log(message);
}

/** A hint or warning. Always stderr — it is never the result of the command. */
export function hint(message: string): void {
  console.error(message);
}

/**
 * `"12.340000"` -> `"$12.34"`, and `"-72.355716"` -> `"-$72.36"`.
 *
 * One implementation, here, because there were two. `billing.ts` handled a leading minus and
 * `whoami.ts` did not, so the same drawn-down account rendered `-$72.35` in one command and the
 * malformed `$-72.35` in the other. A money formatter is exactly the kind of four-line helper that
 * gets copied rather than imported, and exactly the kind where the copy is wrong in the case nobody
 * had yet.
 *
 * Works on the STRING. The gateway sends fixed-point decimal strings, and parsing money into a
 * float to format it reintroduces the representation error those strings exist to avoid. The cents
 * are rounded half-up from the remaining digits rather than truncated, so a balance of
 * `-72.355716` reads `-$72.36` — a displayed figure should never flatter the account by a cent.
 */
export function usd(amount: string | number): string {
  const raw = String(amount);
  const negative = raw.trimStart().startsWith('-');
  const [whole, frac = ''] = raw.replace('-', '').split('.');

  // Round on the digit AFTER the cents, carrying into the whole part when it overflows.
  const cents = Number((frac + '000').slice(0, 3));
  let dollars = BigInt(whole || '0');
  let rounded = Math.round(cents / 10);
  if (rounded === 100) { dollars += 1n; rounded = 0; }

  // A residue too small to show is not a debt. `-0.004` rounding to `-$0.00` would be the only
  // place in the CLI where zero has a sign.
  const sign = negative && (dollars !== 0n || rounded !== 0) ? '-' : '';
  return `${sign}$${dollars}.${String(rounded).padStart(2, '0')}`;
}

/**
 * Emit the success envelope. No-op outside JSON mode, and safe to call more than once.
 *
 * A command that produced no payload still emits `{"ok":true,"data":null}` rather than nothing, so
 * a caller can always parse stdout instead of special-casing empty output.
 */
export function flushSuccess(): void {
  if (!jsonMode || flushed) return;
  flushed = true;
  const data = collected.length === 0 ? null : collected.length === 1 ? collected[0] : collected;
  process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
}

interface ErrorLike {
  message?: string;
  code?: string;
  status?: number;
  requestId?: string;
  isRetryable?: boolean;
  exitCode?: number;
  details?: Record<string, unknown>;
}

/**
 * Emit the failure envelope (JSON mode) or a human error line (table mode), and return the exit code.
 *
 * `retryable` is taken from the SDK's own `CertenError.isRetryable` wherever the error came from the
 * gateway, so the CLI and the SDK hand an automated caller the identical retry decision. That
 * equivalence is the property worth having: a script can switch transports without re-deriving which
 * failures are worth another attempt.
 */
export function emitFailure(err: unknown): ExitCode {
  const e = (err ?? {}) as ErrorLike;
  const message = e.message ?? String(err);
  const code = e.code ?? 'UNKNOWN_ERROR';
  const retryable = e instanceof CliError ? e.retryable : Boolean(e.isRetryable);
  const exitCode = resolveExitCode(e);

  // A refusal for lack of funds is the one failure that carries its own fix, so it
  // is rendered rather than reduced to a code and a message. The developer is
  // already in a terminal; the next command belongs there, not in documentation.
  const payment = err instanceof CertenPaymentRequiredError ? err : null;

  if (jsonMode) {
    flushed = true;
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: {
          code,
          message,
          retryable,
          ...(e.status !== undefined ? { status: e.status } : {}),
          ...(e.requestId ? { requestId: e.requestId } : {}),
          // A failure that still produced a result carries it, rather than throwing the result
          // away in order to signal the failure. See CliError.details.
          ...(e.details ? { details: e.details } : {}),
          // Additive: a consumer that ignores unknown keys is unaffected, and one
          // that wants to settle automatically no longer has to parse prose.
          ...(payment
            ? {
              shortfall_usd: payment.shortfallUsd,
              quote_id: payment.quoteId,
              resolve: payment.resolution,
            }
            : {}),
        },
      })}\n`,
    );
  } else {
    console.error(code === 'UNKNOWN_ERROR' ? `Error: ${message}` : `Error [${code}]: ${message}`);
    if (payment) emitPaymentFix(payment);
  }

  return exitCode;
}

/**
 * Print the way out of a 402.
 *
 * All on stderr: it is guidance, not the result of the command, and a caller
 * piping stdout must still get clean output (or, in JSON mode, exactly one
 * envelope). The closing line matters as much as the address — a developer whose
 * request was refused needs to know nothing was charged and nothing started.
 */
function emitPaymentFix(payment: CertenPaymentRequiredError): void {
  console.error('');
  console.error(`  ${payment.summary}`);

  const r = payment.resolution;
  if (r) {
    console.error('');
    console.error(`  Send exactly ${r.amount_usd} USD on ${r.chain} to:`);
    console.error(`      ${r.to_address}`);
    console.error(`  Reference ${r.payment_intent}`);
    console.error('');
    console.error(`  Or run:  ${r.cli_command}`);
    console.error(`  Portal:  ${r.portal_url}`);
  }

  if (payment.quoteId) {
    console.error('');
    console.error(`  Then retry with --quote-id ${payment.quoteId} to keep this price.`);
  }

  console.error('');
  console.error('  Nothing was charged and no work was started.');
}

function resolveExitCode(e: ErrorLike): ExitCode {
  if (typeof e.exitCode === 'number') return e.exitCode as ExitCode;
  // status 0 is how the SDK reports "the request never reached the gateway".
  if (e.code === 'NETWORK_ERROR' || e.status === 0) return EXIT.UNREACHABLE;

  // Falling through to FAILED is correct for a genuine operation failure and WRONG for a plain
  // `throw new Error('you forgot a flag')`, which should be a usage error and exit 2. Several
  // commands shipped that mistake, and it is invisible: both cases exit 1 and read identically.
  // There is no safe way to guess here — a bare Error carries nothing to distinguish them — so
  // the fix is at the throw site, and this makes the throw site findable rather than silent.
  if (process.env.CERTEN_DEBUG === '1' && e.code === undefined) {
    const name = (e as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';
    console.error(
      `[certen debug] exit 1 from an untyped ${name} — if this is a wrong invocation it should `
      + 'throw UsageError and exit 2.',
    );
  }
  return EXIT.FAILED;
}

// ── table rendering (human mode only) ───────────────────────────────────────────────────────────

function printTable(data: Record<string, unknown>[] | Record<string, unknown>): void {
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
