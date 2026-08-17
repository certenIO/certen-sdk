import { Command } from 'commander';
import { CertenClient, type ErrorCodeInfo } from '@certen.io/sdk';
import { getApiUrl, getOutputFormat } from '../config.js';
import { printOutput, human, hint, isJsonMode } from '../output.js';
import { CliError, EXIT } from '../errors.js';

/**
 * The error vocabulary, read from the gateway you are actually talking to.
 *
 * The catalogue was published in the gateway and then had no client surface for a release — so the
 * codes stayed exactly as discoverable as before, which is to say you found them by provoking them
 * in production. Worse, the SDK ships a vendored copy that is only as current as its release, so a
 * gateway ahead of the SDK raises codes nothing local has heard of.
 *
 * `certen errors <CODE>` is the command that earns this: it is the thing to run when a code shows
 * up in a log and the question is whether to retry, pay, or wake someone.
 */

/** No API key: understanding an error should never require holding a credential. */
function publicClient(): CertenClient {
  return new CertenClient({ apiKey: process.env.CERTEN_API_KEY ?? 'public', baseUrl: getApiUrl() });
}

const machineOutput = (): boolean => isJsonMode() || getOutputFormat() === 'json';

function describe(e: ErrorCodeInfo): void {
  human('');
  human(`  ${e.code}   HTTP ${e.status}`);
  human('');
  human(`  ${e.meaning}`);
  human('');
  // These two are the whole decision. `retryable` says whether the same request can ever work;
  // `audience` says whether there is anything on your side to change at all — and being told
  // "nothing you can do" is genuinely useful, because it stops the debugging.
  human(`  Retrying this exact request: ${e.retryable ? 'can succeed' : 'will not help'}`);
  if (e.audience === 'platform') {
    human('  Cause: on CERTEN\'s side. Nothing in your request changes this.');
  }
  if (e.action) {
    human('');
    human(`  ${e.action}`);
  }
  human('');
}

export function registerErrorsCommands(program: Command): void {
  program
    .command('errors [code]')
    .description('Every error code this API can return, and what to do about each')
    .option('--retryable', 'Only codes where repeating the request can succeed')
    .action(async (code: string | undefined, opts: { retryable?: boolean }) => {
      const { errors } = await publicClient().admin.errors();

      if (code) {
        const wanted = code.toUpperCase();
        const found = errors.find((e) => e.code.toUpperCase() === wanted);
        if (!found) {
          // Near-misses beat a bare "not found": the usual reason to be here is a code copied out
          // of a log with a typo, or one this gateway does not raise.
          const near = errors
            .filter((e) => e.code.includes(wanted) || wanted.includes(e.code))
            .map((e) => e.code);
          throw new CliError(
            `This gateway does not raise "${code}".`
            + (near.length ? ` Did you mean: ${near.join(', ')}?` : ' See them all: certen errors'),
            'UNKNOWN_ERROR_CODE', EXIT.USAGE,
          );
        }
        if (machineOutput()) {
          printOutput({ ...found });
          return;
        }
        describe(found);
        return;
      }

      const shown = opts.retryable ? errors.filter((e) => e.retryable) : errors;

      if (machineOutput()) {
        printOutput({ errors: shown });
        return;
      }

      const w = Math.max(...shown.map((e) => e.code.length), 4);
      human('');
      for (const e of shown) {
        // `retry` is the one column worth carrying in a list — it is what someone scanning for a
        // code in a log actually wants to know before reading the description.
        human(`  ${e.code.padEnd(w)}  ${String(e.status).padEnd(3)}  ${e.retryable ? 'retry' : '     '}  ${e.meaning}`);
      }
      human('');
      human(`  ${shown.length} code(s)${opts.retryable ? ' where retrying can succeed' : ''}.`);
      hint('certen errors PLAN_QUOTA_EXCEEDED   # what one code means and what to do');
    });
}
