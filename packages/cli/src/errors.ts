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
  /** `proof verify` only: the layers the proof carries were checked and a layer is not established (named in the output). */
  PARTIAL: 4,
  /** `proof verify` only: there is no evidence the Accumulate side can be checked from. */
  NO_EVIDENCE: 5,
  /**
   * Ctrl-C while the command was WAITING (`setup` and `gas` for funds to arrive). The shell's own convention for a SIGINT, and the one the CLI UX plan
   * uses for `watch`. Only ever a stop requested by the person; nothing was left half-done, and the command says how to continue.
   */
  INTERRUPTED: 130,
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
  /**
   * Structured payload carried alongside the failure.
   *
   * Some commands fail and still have a result worth handing over — `doctor` is the case this
   * exists for: the diagnosis ran successfully and every check it performed is exactly what an
   * automated caller wants, but "a check failed" must still be a non-zero exit or CI treats a
   * broken setup as a working one. Discarding the checks to signal the failure would make the
   * machine interface strictly less useful than the human one.
   *
   * Additive, and rendered under `error.details`. A consumer that ignores unknown keys is
   * unaffected, which is the same property the 402 payment fields rely on.
   */
  readonly details?: Record<string, unknown>;
  /**
   * The ONE command to run next, when the thrower knows it better than the code does (it has the chain, the key or the intent id in hand).
   *
   * Most errors leave this unset and `next-step.ts` answers from the code. It must be a command line this CLI accepts, with `<angle>` tokens only
   * where the person has to choose; build the parts with `chainArg`, `uuidArg` and `keyArg` so a value that came from the gateway can never put
   * anything but a plain token on a line someone may paste into a shell (or an agent may run).
   */
  readonly next?: string;

  constructor(
    message: string,
    code: string,
    exitCode: ExitCode = EXIT.FAILED,
    retryable = false,
    details?: Record<string, unknown>,
    next?: string,
  ) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
    this.retryable = retryable;
    this.details = details;
    this.next = next;
  }
}

/** A wrong invocation: exits 2, never retryable. */
export class UsageError extends CliError {
  constructor(message: string, code = 'USAGE_ERROR', next?: string) {
    super(message, code, EXIT.USAGE, false, undefined, next);
    this.name = 'UsageError';
  }
}
