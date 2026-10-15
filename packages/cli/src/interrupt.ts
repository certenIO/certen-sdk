/**
 * Catching Ctrl-C for the one place that wants to: a wait for funds.
 *
 * Node's default for SIGINT is to stop the process on the spot. That is right almost everywhere in this CLI (a prompt, a request) and wrong
 * for a command that has been waiting minutes for a faucet: it should say what is saved and how to continue, and leave with a status a script
 * can read. So the handler is installed for the length of that wait and not a moment longer. A listener that stayed behind would make Ctrl-C
 * stop working in every later step, because registering any SIGINT listener removes node's default.
 */
export interface Interrupt {
  /** Aborted when SIGINT arrives. */
  signal: AbortSignal;
  /** Remove the handler. Idempotent; call it in a `finally`. */
  dispose(): void;
}

export function trapSigint(proc: Pick<NodeJS.Process, 'on' | 'off'> = process): Interrupt {
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  proc.on('SIGINT', onSigint);
  let disposed = false;
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      proc.off('SIGINT', onSigint);
    },
  };
}
