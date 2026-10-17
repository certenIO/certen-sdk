import { CertenClient } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from './config.js';
import { printOutput, human } from './output.js';
import { CliError, UsageError, EXIT } from './errors.js';
import { assertChain } from './chains.js';
import { chainArg, uuidArg } from './next-step.js';
import { resolveContext, requireIdentity, requireChain, echoFromContext, sourceLabel } from './context.js';
import { resolveCommandIdentity, abstractAccountFor } from './command-context.js';
import { assertTransferInputs, estimateLines, nativeAssetFor, transferIntent } from './estimate.js';

/**
 * `certen quote <amount> <asset> --to <address>`: the gateway's estimate for a send, before you send it.
 *
 * It is `certen quote` given the same inputs as `certen send`, so the request you quote is the request you can then run. Given none of them,
 * `quote` is what it has always been: a binding price for an operation by SKU (billing.ts). The two answer different questions and are told
 * apart by what you give them.
 *
 * What it asks is `POST /v1/transaction/quote`, which runs admission's gates against the request and creates nothing: no intent, no quote id, no
 * hold, no charge, and no signature (it needs no key). The answer is an ESTIMATE and is printed as one, with the gates it looked at and the ones it
 * did not. A shortfall in your gateway balance is a fact in the answer, not a failure of the command: the exit code says the gateway answered.
 */

export interface IntentQuoteFlags {
  to?: string;
  chain?: string;
  identity?: string;
  /** Only when the person gave one: unlike the price quote's, this has no default (omitted, the gateway prices it as admission does). */
  proofClass?: 'on_demand' | 'on_cadence';
}

export async function runIntentQuote(amount: string | undefined, asset: string | undefined, flags: IntentQuoteFlags): Promise<void> {
  if (amount === undefined || asset === undefined) {
    throw new UsageError('To quote a send, give what you would send: certen quote <amount> <asset> --to <address>', 'MISSING_VALUE');
  }
  if (flags.to === undefined) {
    throw new UsageError('To quote a send, say where it would go: certen quote <amount> <asset> --to <address>', 'MISSING_VALUE');
  }
  assertTransferInputs(amount, flags.to);

  // Reading the gateway's view moves nothing, so a chain that came from a default is fine, as it is for `gas`.
  const ctx = resolveContext({ identity: flags.identity, chain: flags.chain });
  requireIdentity(ctx);
  const chainFrom = requireChain(ctx);
  const chain = assertChain(chainFrom.value, sourceLabel(chainFrom, '--chain'));
  const symbol = nativeAssetFor(chain, asset, amount, flags.to);

  const client = new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
  const who = await resolveCommandIdentity(ctx, client, 'id');
  echoFromContext('chain', ctx.chain);

  const identity = await client.identity.get(who.id!, { include: [] });
  const fromAddress = abstractAccountFor(identity, chain);
  if (!fromAddress) {
    throw new CliError(
      `This identity has no abstract account on ${chain}, so there is no sender to quote. Link the chain: certen identity link-chain ${who.id} --chain ${chain}`,
      'CHAIN_NOT_LINKED', EXIT.FAILED, false, undefined,
      `certen identity link-chain ${uuidArg(who.id)} --chain ${chainArg(chain)}`,
    );
  }

  // Errors are the command's own here: this is the question that was asked, not a convenience on something else, so a refusal or a gateway
  // without the route is reported as a failure (with the gateway's code), unlike the same call on `send`'s card.
  const quote = await client.transaction.quote({
    intent: transferIntent({ adiUrl: identity.adi_url, chain, fromAddress, toAddress: flags.to, amount }),
    ...(flags.proofClass ? { proofClass: flags.proofClass } : {}),
  });

  printOutput(quote as unknown as Record<string, unknown>, { machineOnly: true });
  human('');
  human(`  Estimate for sending ${amount} ${symbol} on ${chain}`);
  human(`    from  ${identity.adi_url}  ->  ${fromAddress} (abstract account)`);
  human(`    to    ${flags.to}`);
  human('');
  for (const line of estimateLines({ state: 'available', quote })) human(`  ${line}`);
  human('');
  human(`  To send it: certen send ${amount} ${symbol} --to ${flags.to}`);
  human('');
}
