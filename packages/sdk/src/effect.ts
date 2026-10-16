import { CertenError } from './errors.js';
import { chainInfo, formatUnits, parseUnits } from './chains.js';
import { assertRpcChain, checkEvmRpcEndpoint, readEvmBalance, type EvmRpcOptions } from './evm-rpc.js';

/**
 * Did the value actually arrive?
 *
 * A proof says an execution happened as the bundle shows. It does not say the person on the other end can spend the money, and a person
 * who just sent value wants to know that. So after a native transfer there is a second, plainer question: did the recipient's balance go up
 * by the amount?
 *
 * **Who is asked matters, and the answer says who.**
 *  - The recipient is read from a node the CALLER chose (`rpc`), never from CERTEN: the gateway has no read of an arbitrary address, and
 *    would not be an independent witness if it had. Without a node the recipient is `unchecked`, and says how to turn the check on. It is
 *    never `confirmed` on the strength of anything else.
 *  - The sender (the abstract account) is read from the gateway, because that is the only place it can be read from. It is shown as
 *    supporting evidence ("the account's balance fell by X, as the gateway reports it") and never decides the verdict on its own.
 *
 * **What the numbers can and cannot show.** A balance difference is a difference between two moments. Other transfers to the same address in
 * between make the rise larger (the verdict says "at least"); a transfer FROM the address in between can make it smaller than the amount
 * even though the value arrived (the verdict says what it saw and names that as a possible reason, and does not call the proof wrong). It is
 * an observation, labelled as one, and the receipt's verdict treats `not_observed` as a reason to look, not as a proven failure.
 */

export type EffectState = 'confirmed' | 'not_observed' | 'unchecked' | 'unreadable' | 'not_applicable';

export interface BalanceMove {
  /** `rpc`: the caller's own node. `gateway`: the CERTEN gateway's report. */
  source: 'rpc' | 'gateway';
  /** The node's host (never its URL, which can carry a key). Absent for the gateway. */
  host?: string;
  address: string;
  symbol: string;
  /** Whole-unit decimal strings, or null when that reading was not made. */
  before: string | null;
  after: string | null;
  /** After minus before, signed. Null when either reading is missing. */
  delta: string | null;
  /** The block the `after` reading is at, or `latest`; null for the gateway. */
  at_block: number | 'latest' | null;
}

export interface ReceiptEffect {
  kind: 'native_transfer' | 'contract_call' | 'none';
  state: EffectState;
  /** What was found, in words. */
  detail: string;
  /** The amount that was meant to arrive, whole units. */
  amount?: string;
  symbol?: string;
  /** The recipient, read from the caller's own node. Absent when no node was given. */
  recipient?: BalanceMove;
  /** The abstract account, read from the gateway. Supporting evidence only. */
  sender?: BalanceMove;
  /** For a contract call checked with an expected event: whether the proof's receipt carries it. Null when it was not looked for. */
  expected_event?: { found: boolean | null };
}

/** The recipient's balance taken BEFORE signing, so a later read has something to be compared with. Stored in the receipt. */
export interface RecipientSnapshot {
  address: string;
  /** Base units, as a decimal string. */
  wei: string;
  host: string;
  chain_id: number;
  taken_at: string;
}

const none = (detail: string): ReceiptEffect => ({ kind: 'none', state: 'not_applicable', detail });

/** The effect of something that is not a native transfer and has nothing to compare: said, not skipped. */
export const noEffectToCheck = none;

/**
 * Take the recipient's balance now, from the caller's node, after checking the node is on the chain.
 *
 * Done BEFORE the signature so the rise can be measured. Throws on a wrong chain or an unreadable node: the caller decides whether a node
 * it was told to use and cannot use stops the send (it does: the person asked for an independent check and should not discover it was not made
 * after the value has moved).
 */
export async function snapshotRecipient(p: EvmRpcOptions & { chain: string; address: string; now?: () => Date }): Promise<RecipientSnapshot> {
  const info = chainInfo(p.chain);
  const { host } = checkEvmRpcEndpoint(p.rpc);
  await assertRpcChain(p, p.chain);
  const wei = await readEvmBalance(p, p.address, 'latest');
  return { address: p.address, wei: wei.toString(), host, chain_id: info!.chainId, taken_at: (p.now?.() ?? new Date()).toISOString() };
}

function move(source: 'rpc' | 'gateway', address: string, symbol: string, decimals: number, before: bigint | null, after: bigint | null, atBlock: number | 'latest' | null, host?: string): BalanceMove {
  return {
    source, ...(host ? { host } : {}), address, symbol,
    before: before === null ? null : formatUnits(before, decimals),
    after: after === null ? null : formatUnits(after, decimals),
    delta: before === null || after === null ? null : formatUnits(after - before, decimals),
    at_block: atBlock,
  };
}

export interface NativeEffectParams extends Partial<EvmRpcOptions> {
  chain: string;
  recipient: string;
  /** What was meant to arrive, whole units. */
  amount: string;
  /** The block the transfer executed in, from the verified execution proof. */
  atBlock?: number;
  /** The recipient's balance taken before signing (`snapshotRecipient`). Without it, the balance one block earlier is the baseline. */
  before?: RecipientSnapshot;
  /** The abstract account's native balance (whole units) before signing and now, as the gateway reports them. */
  sender?: { address: string; before: string | null; after: string | null };
}

/**
 * Judge a native transfer from the recipient's side (and the sender's, as support).
 *
 * Never throws: a node that cannot be read is `unreadable` with the reason, which is a different thing from the balance not having risen.
 */
export async function checkNativeTransferEffect(p: NativeEffectParams): Promise<ReceiptEffect> {
  const info = chainInfo(p.chain);
  if (!info) {
    return { kind: 'native_transfer', state: 'unchecked', amount: p.amount, detail: `${p.chain} is not a chain this client knows, so what a balance means there cannot be stated.` };
  }
  const { nativeDecimals: decimals, nativeSymbol: symbol } = info;
  const want = parseUnits(p.amount, decimals);
  if (want === undefined) {
    return { kind: 'native_transfer', state: 'unchecked', amount: p.amount, symbol, detail: `The amount ${JSON.stringify(p.amount)} is not one this client can compare a balance with.` };
  }

  // The sender, from the gateway. Supporting only.
  let sender: BalanceMove | undefined;
  let senderNote = '';
  if (p.sender) {
    const b = parseUnits(p.sender.before ?? undefined, decimals);
    const a = parseUnits(p.sender.after ?? undefined, decimals);
    sender = move('gateway', p.sender.address, symbol, decimals, b ?? null, a ?? null, null);
    if (b !== undefined && a !== undefined) {
      senderNote = b - a >= want
        ? ` The abstract account's balance fell by ${formatUnits(b - a, decimals)} ${symbol} (as the gateway reports it).`
        : b - a > 0n
          ? ` The abstract account's balance fell by ${formatUnits(b - a, decimals)} ${symbol}, less than ${p.amount} (as the gateway reports it).`
          : ' The abstract account\'s balance has not fallen yet (as the gateway reports it; its view can lag).';
    }
  }

  if (!p.rpc) {
    return {
      kind: 'native_transfer', state: 'unchecked', amount: p.amount, symbol, ...(sender ? { sender } : {}),
      detail: `The recipient's balance was not checked: no node of yours was given, and the gateway cannot read another address.${senderNote}`,
    };
  }

  const opts: EvmRpcOptions = { rpc: p.rpc, fetch: p.fetch, timeoutMs: p.timeoutMs };
  let host: string;
  try {
    host = checkEvmRpcEndpoint(p.rpc).host;
    await assertRpcChain(opts, p.chain);
  } catch (err) {
    return {
      kind: 'native_transfer', state: 'unreadable', amount: p.amount, symbol, ...(sender ? { sender } : {}),
      detail: `${(err instanceof CertenError ? err.message : String(err)).replace(/^certen: /, '')}${senderNote}`,
    };
  }

  try {
    let before: bigint;
    if (p.before) {
      if (p.before.address.toLowerCase() !== p.recipient.toLowerCase() || p.before.chain_id !== info.chainId) {
        return {
          kind: 'native_transfer', state: 'unreadable', amount: p.amount, symbol, ...(sender ? { sender } : {}),
          detail: 'The balance saved before signing is for another address or chain, so it is not a baseline for this one.',
        };
      }
      before = BigInt(p.before.wei);
    } else if (p.atBlock !== undefined && p.atBlock > 0) {
      before = await readEvmBalance(opts, p.recipient, p.atBlock - 1);
    } else {
      return {
        kind: 'native_transfer', state: 'unreadable', amount: p.amount, symbol, ...(sender ? { sender } : {}),
        detail: `There is no balance from before the transfer and no block to measure it against.${senderNote}`,
      };
    }

    // At the execution block when it is known and the node still has that state; otherwise the latest. Both are labelled.
    let after: bigint;
    let at: number | 'latest' = 'latest';
    if (p.atBlock !== undefined) {
      try { after = await readEvmBalance(opts, p.recipient, p.atBlock); at = p.atBlock; } catch { after = await readEvmBalance(opts, p.recipient, 'latest'); }
    } else {
      after = await readEvmBalance(opts, p.recipient, 'latest');
    }

    const recipient = move('rpc', p.recipient, symbol, decimals, before, after, at, host);
    const delta = after - before;
    const where = `${at === 'latest' ? 'now' : `at block ${at}`} on the node at ${host}`;
    if (delta >= want) {
      return {
        kind: 'native_transfer', state: 'confirmed', amount: p.amount, symbol, recipient, ...(sender ? { sender } : {}),
        detail: delta === want
          ? `The recipient's balance rose by exactly ${p.amount} ${symbol} (${where}).${senderNote}`
          : `The recipient's balance rose by ${formatUnits(delta, decimals)} ${symbol}, at least the ${p.amount} sent (other transfers to it may be included) (${where}).${senderNote}`,
      };
    }
    return {
      kind: 'native_transfer', state: 'not_observed', amount: p.amount, symbol, recipient, ...(sender ? { sender } : {}),
      detail: `The recipient's balance changed by ${formatUnits(delta, decimals)} ${symbol} (${where}), not the ${p.amount} sent. `
        + `The value may have been spent from that address since, or a block may differ from the one read; the proof is what says what executed.${senderNote}`,
    };
  } catch (err) {
    return {
      kind: 'native_transfer', state: 'unreadable', amount: p.amount, symbol, ...(sender ? { sender } : {}),
      // The node's own messages already name the host and never the URL (evm-rpc.ts); anything else is reduced to its class.
      detail: `The recipient's balance could not be read from the node at ${host}: `
        + `${err instanceof CertenError ? err.message.replace(/^certen: the node at \S+ /, '').replace(/^certen: /, '') : 'an unexpected error'}${senderNote}`,
    };
  }
}
