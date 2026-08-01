/**
 * Exit codes and the local error taxonomy.
 *
 * The CLI used to exit `1` for everything — a bad flag, a rejected request, and an unreachable
 * gateway were indistinguishable without reading English off stderr. An automated caller cannot
 * make a retry decision from that: "you passed a malformed address" and "the gateway is down" want
 * opposite responses, and only one of them is worth retrying.
 *
 * These four codes are a contract. See docs/CLI-CONTRACT.md.
 */
export const EXIT = {
  /** Success. */
  OK: 0,
  /** The request was well-formed and the gateway answered, but the operation did not succeed. */
  FAILED: 1,
  /** The invocation was wrong: unknown command, missing flag, no API key configured. */
  USAGE: 2,
  /** The gateway could not be reached at all. Nothing was submitted. */
  UNREACHABLE: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * An error raised by the CLI itself rather than by the gateway.
 *
 * `code` is machine-readable and lives in the same namespace as the gateway's codes, so a caller
 * branching on `error.code` does not need to know whether the failure was local or remote.
 */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly retryable: boolean;

  constructor(message: string, code: string, exitCode: ExitCode = EXIT.FAILED, retryable = false) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
    this.retryable = retryable;
  }
}

/** A wrong invocation: exits 2, never retryable. */
export class UsageError extends CliError {
  constructor(message: string, code = 'USAGE_ERROR') {
    super(message, code, EXIT.USAGE, false);
    this.name = 'UsageError';
  }
}
