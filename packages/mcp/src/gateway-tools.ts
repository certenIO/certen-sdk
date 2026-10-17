import { randomUUID } from 'node:crypto';
import { CertenError, evmAddressProblem } from '@certen.io/sdk';
import type {
  AddressBalanceResponse, CertenClient, ChainDripResponse, CreditTopUpResponse, IdentityReadinessResponse, TransactionQuoteParams, TransactionQuoteResponse,
} from '@certen.io/sdk';
import { chainName, given, onlyKnown, refuse, uuid } from './agent-tools.js';
import { assertChainUsable, assertIntentChains } from './chains.js';

/**
 * What the five tools for the gateway's newer operations do around the SDK: `certen_chain_balance`, `certen_identity_readiness`, `certen_intent_quote`
 * (all read) and `certen_credits_topup`, `certen_gas_drip` (write).
 *
 * The SDK has already done the hard parts (`chains.balance` refuses a mistyped address, `identity.topUpCredits` refuses a credit count that is not a whole
 * number, both spending calls always send an Idempotency-Key). What belongs HERE is this server's rules, which an SDK user does not share:
 *
 *   - **Every mistake is caught before a request**, and told as a mistake (status 0, `nothing was sent`), not as a gateway answer to nonsense. The address is
 *     checked before the chain, because checking an opt-in chain can ask the gateway.
 *   - **The two spending tools return the Idempotency-Key they used**, and carry it on a failure too. The SDK generates a key when it is given none and keeps
 *     it to itself, which is fine for code that retries on its own and fatal for an agent: a call that times out leaves the agent holding no key, and the
 *     retry it makes next is a NEW request, a second draw on the platform's funds. So this server makes the key, hands it to the SDK, and hands it back.
 *   - **An outcome nobody knows is never reported as a success.** `unconfirmed` (and any status this server does not know) says so in `next_step`, and says
 *     what to read instead of asking again.
 *   - **A feature the operator has not switched on is said plainly**, once, as a setting and not as a fault: retrying cannot change it.
 *   - **An argument the tool does not have is refused by name, not ignored.** Especially for the drip, whose destination and amount are not the caller's.
 *
 * Nothing here takes a node, a host or a URL, and nothing here reads or returns the API key.
 */

type Env = Record<string, string | undefined>;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A value for an error message, safe for anything a caller might send (JSON.stringify throws on a BigInt and prints `undefined` for nothing). */
const show = (value: unknown): string => (typeof value === 'string' ? JSON.stringify(value) : `a value of type ${typeof value}`);

// ── the three reads ───────────────────────────────────────────────────────────────────────────────────

/** The native balance of any EVM address on a chain, read through the gateway's own node. */
export async function runChainBalanceTool(client: CertenClient, args: Record<string, unknown>, env: Env): Promise<AddressBalanceResponse> {
  onlyKnown('certen_chain_balance', 'arguments', args, ['chain', 'address'], 'The balance is read through the gateway\'s own node for the chain; there is no node to name.');
  const raw = chainName(args.chain, 'certen_chain_balance');
  // Before the chain is checked: an opt-in chain is checked against the gateway, and a mistyped address must send nothing at all.
  const problem = evmAddressProblem(args.address);
  if (problem) throw refuse(`${problem} Nothing was sent.`, 'INVALID_ADDRESS');
  const chain = await assertChainUsable(client, raw, env);
  return client.chains.balance(chain, args.address as string);
}

/** Facts about one identity in one read. Says nothing like "ready"; each section carries its own state. */
export async function runIdentityReadinessTool(client: CertenClient, args: Record<string, unknown>, env: Env): Promise<IdentityReadinessResponse> {
  onlyKnown('certen_identity_readiness', 'arguments', args, ['identity_id', 'chain'], 'The facts come from the gateway in one read; there is no node to name.');
  const id = uuid(args, 'identity_id', 'INVALID_IDENTITY_ID', 'the identity\'s id (an acc:// URL is not accepted: certen_portfolio_get lists the ids)');
  const chain = given(args.chain) ? await assertChainUsable(client, chainName(args.chain, 'certen_identity_readiness'), env) : undefined;
  return client.identity.readiness(id, chain === undefined ? {} : { chain });
}

/** An estimate of what an intent would cost and whether it would be admitted. Creates, charges and signs nothing. */
export async function runIntentQuoteTool(client: CertenClient, args: Record<string, unknown>, env: Env): Promise<TransactionQuoteResponse> {
  onlyKnown('certen_intent_quote', 'arguments', args, ['intent', 'proof_class'], 'The estimate is the gateway\'s; there is no node to name.');
  if (!isRecord(args.intent)) {
    throw refuse(`intent must be the object you would pass to certen_transaction_open ({fromChain,toChain,amount,...} or {adiUrl,legs:[...]}), got ${show(args.intent)}. Nothing was sent.`, 'INVALID_INTENT');
  }
  let proofClass: TransactionQuoteParams['proofClass'];
  if (given(args.proof_class)) {
    if (args.proof_class !== 'on_demand' && args.proof_class !== 'on_cadence') {
      throw refuse(`proof_class must be "on_demand" or "on_cadence", got ${show(args.proof_class)}. Leave it out to be priced as unclassified. Nothing was sent.`, 'INVALID_PROOF_CLASS');
    }
    proofClass = args.proof_class;
  }
  // The same rule as certen_transaction_open: an estimate for a chain this server would refuse to open on is an estimate of something that cannot happen here.
  await assertIntentChains(client, args.intent, env);
  return client.transaction.quote({ intent: args.intent as unknown as TransactionQuoteParams['intent'], proofClass });
}

// ── the two that spend the platform's funds ───────────────────────────────────────────────────────────────────

/** Letters, digits and `. _ : -`: enough for a UUID or an order number, and nothing that can break out of a header. */
const KEY_SHAPE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The key this request carries: the caller's, or a fresh one made here. Made HERE and not by the SDK so that it can be returned: see the file header.
 * A key is not a secret (it is an id for one request), so it is shown whole.
 */
function idempotencyKeyOf(args: Record<string, unknown>): string {
  if (!given(args.idempotency_key)) return randomUUID();
  const key = args.idempotency_key;
  if (typeof key !== 'string' || !KEY_SHAPE.test(key)) {
    throw refuse(`idempotency_key must be 1 to 128 characters from letters, digits and . _ : - (a UUID is ideal), got ${show(key)}. Nothing was sent.`, 'INVALID_IDEMPOTENCY_KEY');
  }
  return key;
}

/** A whole number of credits, at least 1. The SDK refuses the same values; checking here says it in this tool's words, and a string such as "100" is not one. */
function creditsOf(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value;
  const got = typeof value === 'number' ? String(value) : show(value);
  throw refuse(
    `credits must be a whole number of credits, at least 1 (1 credit = $0.01; it is a COUNT of credits, never an amount of ACME), got ${got}. Nothing was sent.`,
    'INVALID_CREDITS',
  );
}

/** What to say about an error from a spending call, beyond the gateway's own message. */
const GUIDANCE: Record<string, string> = {
  CREDIT_TOPUP_DISABLED:
    'Credit top-up is not switched on for this gateway: its operator has to enable it. That is a setting, not a fault, and retrying cannot change it. Nothing was drawn. '
    + 'Tell the user plainly; do not retry.',
  DRIP_DISABLED:
    'The gas drip is not switched on for this gateway: its operator has to enable it. That is a setting, not a fault, and retrying cannot change it. Nothing was sent. '
    + 'Tell the user plainly, and fund the account from a faucet instead (certen_chains_enabled lists each chain\'s).',
  CREDIT_TOPUP_LIMIT:
    'A limit on the platform\'s sponsor funds was reached (the message says which, and how many credits remain). Do not retry before the window it names has passed, '
    + 'and do not change the key or the amount to get around it.',
  DRIP_LIMIT:
    'A limit on the platform\'s sponsor funds was reached (the message says which: this account\'s cooldown, or a daily ceiling). Do not retry before the window it names has passed, '
    + 'and do not change the key to get around it. If the account needs native token sooner, send it from another wallet.',
  DRIP_TESTNET_ONLY: 'The gas drip is for testnets only and this chain is not one. Nothing was sent. Fund the account another way.',
  DRIP_RECIPIENT_REJECTS: 'The account contract did not accept a plain transfer of the native token, so it cannot be dripped. Nothing was sent. Do not retry.',
  IDEMPOTENCY_KEY_MISMATCH:
    'This idempotency_key was already used for a DIFFERENT request. Repeat the original request exactly, or, if you really mean a new one, use a new key (a new key is a new draw).',
  IDEMPOTENCY_KEY_IN_FLIGHT: 'An identical request with this key is still running. Wait, then repeat it with the SAME idempotency_key; never a new one.',
};

/** Codes that are an answer to "did it happen": no. Everything else that did not come back as an answer is not known to have done nothing. */
const NOTHING_DONE = new Set(['BALANCE_UNREADABLE', 'DRIP_UNAVAILABLE']);

const OUTCOME_UNKNOWN =
  'The outcome is not known: the request may have been processed. Do not start a new one. Repeat THIS request with the same idempotency_key (the gateway never acts twice for one key), '
  + 'or first read the state: certen_identity_readiness for an identity\'s credits, certen_chain_balance for an account\'s balance.';

function guidanceFor(error: CertenError): string | undefined {
  const known = GUIDANCE[error.code];
  if (known) return known;
  if (NOTHING_DONE.has(error.code)) return undefined;
  // A transport failure (no answer at all), a timeout, or a server error: the call may well have been made.
  return error.code === 'NETWORK_ERROR' || error.status === 408 || error.status >= 500 ? OUTCOME_UNKNOWN : undefined;
}

/**
 * The failure of a spending call, carrying the key it used and what to do about it. Still a `CertenError` with the same code, status and body, so the server
 * reports it as it reports every other (and `isRetryable` is unchanged); `guidance` and `idempotencyKey` are read by shape, like the other additive fields.
 */
class KeyedCertenError extends CertenError {
  readonly idempotencyKey: string;
  readonly guidance?: string;

  constructor(from: CertenError, key: string) {
    super(from.message, from.status, from.code, { requestId: from.requestId, details: from.details, body: from.body });
    this.idempotencyKey = key;
    this.guidance = guidanceFor(from);
    if (from.stack) this.stack = from.stack;
  }
}

const withKey = (error: unknown, key: string): unknown => (error instanceof CertenError ? new KeyedCertenError(error, key) : error);

export interface CreditTopUpResult extends CreditTopUpResponse {
  /** The Idempotency-Key this request carried. Pass it again to repeat the SAME request; a new key is a new draw. */
  idempotency_key: string;
  /** What this status means and what to do next, in words. */
  next_step: string;
}

function topUpNextStep(r: CreditTopUpResponse, key: string): string {
  const before = typeof r.credits_before === 'number' ? String(r.credits_before) : 'not readable';
  const read = `Read the page's credits with certen_identity_readiness { identity_id: "${r.identity_id}" } (they were ${before} before this)`;
  if (r.status === 'submitted') {
    return `SUBMITTED, NOT CONFIRMED: the bridge accepted a transaction and the network has not confirmed it, so the credits are not yet shown to be on the key page. ${read} before relying on them or topping up again.`;
  }
  // `unconfirmed`, and any status this server does not know: neither is read as done.
  return `${r.status === 'unconfirmed' ? 'UNCONFIRMED' : `NOT CONFIRMED (the gateway answered status ${show(r.status)})`}: the outcome is not known and the credits MAY have been applied `
    + 'and counted against the limits. Do NOT top up again with a new idempotency_key: that could be a second draw on the platform\'s funds. '
    + `${read}. Repeating this exact request with the same idempotency_key ("${key}") is safe: the gateway never draws twice for one key.`;
}

/**
 * Top up the credits of an identity's key page, paid by the platform's sponsor. `credits` is a COUNT of credits (1 = $0.01), never ACME.
 * The result is the gateway's answer, whole, plus the key it used and what the status means.
 */
export async function runCreditsTopupTool(client: CertenClient, args: Record<string, unknown>): Promise<CreditTopUpResult> {
  onlyKnown('certen_credits_topup', 'arguments', args, ['identity_id', 'credits', 'idempotency_key', 'confirm'], 'The credits go to the identity\'s own key page; there is nothing here to point elsewhere.');
  const id = uuid(args, 'identity_id', 'INVALID_IDENTITY_ID', 'the identity\'s id (an acc:// URL is not accepted: certen_portfolio_get lists the ids)');
  const credits = creditsOf(args.credits);
  const key = idempotencyKeyOf(args);
  try {
    const result = await client.identity.topUpCredits(id, { credits, idempotencyKey: key });
    return { ...result, idempotency_key: key, next_step: topUpNextStep(result, key) };
  } catch (error) {
    throw withKey(error, key);
  }
}

export interface ChainDripResult extends ChainDripResponse {
  /** The Idempotency-Key this request carried. Pass it again to repeat the SAME request; a new key is a new drip. */
  idempotency_key: string;
  /** What this status means and what to do next, in words. */
  next_step: string;
}

function dripNextStep(r: ChainDripResponse, key: string): string {
  const balance = `certen_chain_balance { chain: "${r.chain}", address: "${r.address}" }`;
  if (r.status === 'sent') {
    const where = [r.tx_hash ? `in ${r.tx_hash}` : '', r.explorer_url ? `(${r.explorer_url})` : ''].filter(Boolean).join(' ');
    return `SENT: the gateway reports the transfer mined${where ? ` ${where}` : ''}. That is its report; read the account's balance with ${balance} before relying on it.`;
  }
  if (r.status === 'skipped') {
    return `SKIPPED, NOTHING WAS SENT: the account already held enough native token for gas. Read its balance with ${balance} if you need the figure.`;
  }
  return `${r.status === 'unconfirmed' ? 'UNCONFIRMED' : `NOT CONFIRMED (the gateway answered status ${show(r.status)})`}: the drip MAY have been sent and counts against the limits as if it had been. `
    + `Do NOT drip again with a new idempotency_key. Read the account's balance with ${balance} and compare. `
    + `Repeating this exact request with the same idempotency_key ("${key}") is safe: the gateway never sends twice for one key.`;
}

/** Argument names that mean "send it there" or "send this much": the drip has neither, and an agent that passes one must hear that, not get a normal result. */
const DRIP_CHOICE = /^(address|to|recipient|destination|account|wallet|amount|value|wei|tokens?)$/i;

/**
 * A testnet gas drip to the identity's own account on a chain, paid by the platform's sponsor. There is no destination to name and no amount to choose:
 * the account is the gateway's record for the identity and the amount is the operator's.
 */
export async function runGasDripTool(client: CertenClient, args: Record<string, unknown>, env: Env): Promise<ChainDripResult> {
  const choice = Object.keys(args).find((k) => DRIP_CHOICE.test(k));
  if (choice) {
    throw refuse(
      `certen_gas_drip has no "${choice}" argument: the drip goes to the identity's own deployed account on the chain, which the gateway recorded, and the amount is the operator's setting. `
      + 'Neither is the caller\'s to choose. It takes: identity_id, chain, idempotency_key, confirm. Nothing was sent.',
      'UNKNOWN_ARGUMENT',
    );
  }
  onlyKnown('certen_gas_drip', 'arguments', args, ['identity_id', 'chain', 'idempotency_key', 'confirm'], 'The drip is made by the platform\'s own sponsor wallet; there is no node to name.');
  const id = uuid(args, 'identity_id', 'INVALID_IDENTITY_ID', 'the identity\'s id (an acc:// URL is not accepted: certen_portfolio_get lists the ids)');
  const chain = await assertChainUsable(client, chainName(args.chain, 'certen_gas_drip'), env);
  const key = idempotencyKeyOf(args);
  try {
    const result = await client.identity.drip(id, chain, { idempotencyKey: key });
    return { ...result, idempotency_key: key, next_step: dripNextStep(result, key) };
  } catch (error) {
    throw withKey(error, key);
  }
}
