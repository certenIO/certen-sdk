import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { identity } from '@certen.io/proof-verify';
import { EXIT } from '../errors.js';

/**
 * `certen proof verify-identity <@document> --outcome-file <file>`: the contract identity (S8) of a leg, judged from a portable proof document and the
 * outcome evidence file that settles the leg. It is the twin of `proofverify --finality-file <doc> --outcome-file <file> --contract-identity`: the S7
 * (finality) report of the document is printed first, then ONE line of the S8 row, and the exit code is the Freeze item 6 code. It runs on its own
 * exit path and does not touch `certen proof verify`.
 *
 *   0   contract identity: VERIFIED at <level> (registry <via>)
 *   5   contract identity: not applicable (<reason>)
 *   10  contract identity: verified core, <N> open: <part>:<reason>, ...        (never printed, counted or exit-coded as verified)
 *   20  contract identity: PENDING (state root not authenticated; <N> findings)
 *   30  contract identity: UNPROVEN: <parts>
 *   40  contract identity: REFUSED: <first refusal state>
 *   2   usage, an unreadable file, an outcome that settles nothing, or an input that cannot form a container: proofverify: <error>
 *   1   the S7 phase FAILED (it wins over every S8 code)
 *
 * NOTE: these codes are NOT the codes of `certen proof verify`. There 4 is partial and 5 is NO_EVIDENCE; here 5 is "not applicable" and 10..40 are
 * the S8 rows. Read the line, not only the code.
 */
/** The exit codes of the S8 rows that are not in EXIT: the entrypoint lets exactly these through (it turns every other unknown value into a failure). */
export const IDENTITY_EXIT_CODES: readonly number[] = [10, 20, 30, 40];

export const VERIFY_IDENTITY_HELP = [
  'Exit codes (this command only): 0 VERIFIED, 5 not applicable, 10 verified core (never "verified"), 20 PENDING, 30 UNPROVEN, 40 REFUSED,',
  '2 usage or unreadable input, 1 the finality phase FAILED. 5 here is "not applicable"; in `certen proof verify` 5 is NO_EVIDENCE.',
].join('\n');

export function registerProofVerifyIdentity(proof: Command): void {
  proof
    .command('verify-identity <target>')
    .description('Judge the contract identity (S8) of a leg from a portable proof document file (@path) and the outcome evidence that settles it. Needs no API key.')
    .requiredOption('--outcome-file <path>', 'The exported outcome evidence file whose member settled the leg (the Settlement source)')
    .addHelpText('after', `\n${VERIFY_IDENTITY_HELP}\n`)
    .action(async (target: string, opts: { outcomeFile: string }) => {
      const write = (text: string, code: number): void => {
        process.stdout.write(text);
        process.exitCode = code;
      };
      if (!target.startsWith('@')) {
        write(`proofverify: verify-identity takes a portable proof document file (@path); ${JSON.stringify(target)} is a proof id or link and names no outcome evidence to judge it against\n`, EXIT.USAGE);
        return;
      }
      const path = target.slice(1);
      let doc: Buffer;
      let outcome: Buffer;
      try {
        doc = readFileSync(path);
        outcome = readFileSync(opts.outcomeFile);
      } catch (err) {
        write(`proofverify: ${err instanceof Error ? err.message : String(err)}\n`, EXIT.USAGE);
        return;
      }
      const r = await identity.judgeContractIdentityDocument(doc, outcome, { subject: path });
      write(r.text, r.exit);
    });
}
