import { CertenClient, CertenError, evmAddressProblem } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from './config.js';
import { printOutput, hint, human } from './output.js';
import { UsageError } from './errors.js';
import { assertChain } from './chains.js';
import { resolveContext, requireChain, echoFromContext, sourceLabel } from './context.js';
import { printable } from './gateway-text.js';

/**
 * `certen balance <address> [--chain <chain>]`: the native balance of ANY EVM address on a chain the gateway serves.
 *
 * It is `certen balance` with an argument. Without one the command is what it has always been, the organization's balance at the gateway in
 * dollars (billing.ts); the two share a name because both answer "how much is there", and they are told apart by what you give it.
 *
 * Read-only, and the gateway answers through its own node: the figure is the gateway's reading, not yours. `certen receipt --rpc <node>` is the
 * check that does not trust it. A node that did not answer is a failure (`BALANCE_UNREADABLE`, exit 1, retryable), never a balance of zero:
 * an empty account and a failed read look the same to anyone who is shown a 0, which is why the gateway refuses to send one.
 */

export async function runAddressBalance(address: string, opts: { chain?: string }): Promise<void> {
  // Before the context, the credential and the network: a mistyped address costs a message. The SDK would refuse it too, with the same words;
  // it is checked here so the refusal is a usage error (exit 2), which a script reads as "fix the invocation", and not a status-0 SDK error.
  const problem = evmAddressProblem(address);
  if (problem) throw new UsageError(`address: ${problem}`, 'INVALID_ADDRESS');

  // Not value-moving, and no identity is needed: any address can be read. The chain still defaults from the context, as `gas` does.
  const ctx = resolveContext({ chain: opts.chain }, { fields: ['chain'] });
  const chainFrom = requireChain(ctx);
  const chain = assertChain(chainFrom.value, sourceLabel(chainFrom, '--chain'));
  echoFromContext('chain', ctx.chain);

  const client = new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
  let read;
  try {
    read = await client.chains.balance(chain, address);
  } catch (err) {
    if (err instanceof CertenError && err.code === 'BALANCE_UNREADABLE') {
      hint('  The chain\'s node did not answer, so this is NOT a balance of zero: nothing was read. Try again in a moment.');
    }
    throw err;
  }

  printOutput(read as unknown as Record<string, unknown>, { machineOnly: true });
  human('');
  human(`  ${printable(read.address, 80)} on ${printable(read.chain, 40)}`);
  human(`    balance  ${printable(read.balance, 80)} ${printable(read.symbol, 20)}`.trimEnd());
  human(`    read at  ${printable(read.read_at, 40)}   (when the gateway asked its node; not a block time)`);
  human('');
  human('  This is the gateway\'s reading through its own node. To check it against a node you trust: certen receipt <intent> --rpc <url>');
  human('');
}
