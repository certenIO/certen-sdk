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
  opts?: { forceJson?: boolean },
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
        },
      })}\n`,
    );
  } else {
    console.error(code === 'UNKNOWN_ERROR' ? `Error: ${message}` : `Error [${code}]: ${message}`);
  }

  return exitCode;
}

function resolveExitCode(e: ErrorLike): ExitCode {
  if (typeof e.exitCode === 'number') return e.exitCode as ExitCode;
  // status 0 is how the SDK reports "the request never reached the gateway".
  if (e.code === 'NETWORK_ERROR' || e.status === 0) return EXIT.UNREACHABLE;
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
