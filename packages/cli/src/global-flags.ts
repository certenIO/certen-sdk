import { UsageError } from './errors.js';

/**
 * Global flags that may appear anywhere on the command line.
 *
 * `--json` already works this way (see `run()` in index.ts): it is taken out of argv before commander sees it, because commander
 * does not model a global flag that can follow a subcommand. `--profile <name>` is the same kind of flag. Which setup a command
 * runs as is not a property of one command, and `certen call ... --profile testnet` has to mean what `certen --profile testnet
 * call ...` means.
 *
 * It is declared on the root program as well, so it appears in `--help` and `--help --json`; this is what actually reads it.
 */
export function extractProfileFlag(argv: string[]): { argv: string[]; profile: string | undefined } {
  const rest: string[] = [];
  let profile: string | undefined;
  let seen = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const isBare = arg === '--profile';
    const isEquals = arg.startsWith('--profile=');
    if (!isBare && !isEquals) {
      rest.push(arg);
      continue;
    }

    // Two values on one command line would mean the later one silently wins on a command that may sign.
    if (seen) {
      throw new UsageError('--profile was given more than once. Name the profile once.', 'DUPLICATE_PROFILE_FLAG');
    }
    seen = true;

    let value: string | undefined;
    if (isEquals) {
      value = arg.slice('--profile='.length);
    } else {
      value = argv[i + 1];
      // A following flag is not a name: `--profile --json` must not become a profile called "--json".
      if (value !== undefined && !value.startsWith('--')) i += 1;
      else value = undefined;
    }
    if (!value) {
      throw new UsageError('--profile needs a profile name, for example --profile testnet. See them with: certen context', 'MISSING_PROFILE_NAME');
    }
    profile = value;
  }

  return { argv: rest, profile };
}
