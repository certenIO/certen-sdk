import { describe, it, expect } from 'vitest';
import { assembleReceipt, type Receipt, type ReceiptEffect, type ReceiptRequest, type TransactionResponse, type VerificationLike } from '@certen.io/sdk';
import { exitCodeFor, nextCommand, proofLine, receiptLines, stageLine } from '../src/receipt-render.js';

/**
 * Putting a receipt in front of a person, and the exit code it earns.
 *
 * The SDK decides what is established; this decides how it reads and what a script is told. What is pinned is what a wrong rendering would
 * cost: a PARTIAL that reads like a pass, an exit code of 0 for something that was not verified, and a failed intent that hides why.
 *
 * VERIFIED is built here from a synthetic verification, because the repo's only proof fixture has unbound page chains and so can never
 * reach it offline (the subprocess tests show its honest PARTIAL). The synthetic one is `VerificationLike`, the shape `verifyBundle` returns.
 */

const INTENT = '7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b13';
const T0 = new Date('2026-10-15T12:00:00Z');
const TX_HASH = `0x${'cd'.repeat(32)}`;

const tx = (status: string, extra: Record<string, unknown> = {}): TransactionResponse => ({
  intent_id: INTENT, identity_id: 'identity-1', status, created_at: '2026-10-15T00:00:00Z',
  accum_tx_hash: `acc://${'ab'.repeat(32)}@sign-test.acme/data`,
  proof_id: status === 'completed' ? 'proof-1' : null,
  ...extra,
} as TransactionResponse);

const REQUEST: ReceiptRequest = {
  kind: 'transfer', chain: 'base-sepolia', chain_id: 84532, identity_id: 'identity-1', adi_url: 'acc://sign-test.acme',
  from: '0xAbstract', to: '0x1111111111111111111111111111111111111111', amount: '0.0001', asset: 'ETH', contract_call: null,
};

const layer = (id: string, verdict: 'verified' | 'failed' | 'not_checked' | 'not_in_document', reason?: string) => ({
  id, title: `Layer ${id}`, verdict, ...(reason ? { reason } : {}), statement: 'S1',
  ...(verdict === 'verified' ? { evidence: { block: 46437431, root: `0x${'a'.repeat(64)}` } } : {}),
});

const verification = (overall: VerificationLike['overall'], layers: ReturnType<typeof layer>[]): VerificationLike => ({
  overall, layers, evidenceFound: overall !== 'no_evidence',
  execution: { ok: true, txHash: TX_HASH, blockNumber: 46437431, chainId: '84532' }, headerCheck: { ok: true },
});

const CONFIRMED: ReceiptEffect = { kind: 'native_transfer', state: 'confirmed', amount: '0.0001', symbol: 'ETH', detail: 'The recipient\'s balance rose by exactly 0.0001 ETH (at block 46437431 on the node at node.example).' };

function receipt(status: string, over: { proof?: Parameters<typeof assembleReceipt>[0]['proof']; effect?: ReceiptEffect; request?: ReceiptRequest | null; extra?: Record<string, unknown> } = {}): Receipt {
  return assembleReceipt({
    intentId: INTENT, transaction: tx(status, over.extra), request: over.request === undefined ? REQUEST : over.request, now: () => T0,
    registry: { accumulate: { network: 'kermit', environment: 'testnet', api: 'http://x', explorer: 'https://explorer.example' }, chains: [{ id: 'base-sepolia', chainId: 84532, family: 'evm', displayName: 'Base Sepolia', environment: 'testnet', explorer: 'https://sepolia.basescan.org', status: 'live', contracts: {} }] },
    proof: over.proof, effect: over.effect,
  });
}

const VERIFIED = (): Receipt => receipt('completed', {
  proof: { verification: verification('verified', [layer('trust', 'verified'), layer('L1', 'verified'), layer('outcome', 'verified')]), nodeConsulted: true },
  effect: CONFIRMED,
});
const PARTIAL = (): Receipt => receipt('completed', {
  proof: { verification: verification('partial', [layer('trust', 'verified'), layer('G1_chains', 'not_checked', '3 of 3 pages\' chains are not bound'), layer('outcome', 'not_checked', 'the receipts root is the validators\' statement')]), nodeConsulted: false },
  effect: { kind: 'native_transfer', state: 'unchecked', amount: '0.0001', detail: 'The recipient\'s balance was not checked: no node of yours was given.' },
});

describe('exitCodeFor: 0 means verified, and nothing else that is not a failure', () => {
  it('verified is 0', () => expect(exitCodeFor(VERIFIED())).toBe(0));

  it('an executed action whose proof can never exist is 0, and says so rather than "verified"', () => {
    const r = receipt('completed_unproven');
    expect(r.verdict).toBe('unproven');
    expect(exitCodeFor(r)).toBe(0);
    expect(receiptLines(r).join('\n')).toMatch(/EXECUTED, NOT PROVABLE/);
    expect(receiptLines(r).join('\n')).not.toMatch(/VERIFIED/);
  });

  it('a failed intent and a failed proof layer are 1', () => {
    expect(exitCodeFor(receipt('failed', { extra: { reason_code: 'target_reverted' } }))).toBe(1);
    expect(exitCodeFor(receipt('completed', { proof: { verification: verification('failed', [layer('L1', 'failed', 'a step does not hash')]) }, effect: CONFIRMED }))).toBe(1);
    expect(exitCodeFor(receipt('expired'))).toBe(1);
  });

  it('PARTIAL is 4, and so is a pending intent, one that executed with its proof still coming, and a proof that could not be fetched', () => {
    expect(exitCodeFor(PARTIAL())).toBe(4);
    expect(exitCodeFor(receipt('anchoring'))).toBe(4);
    expect(exitCodeFor(receipt('executed'))).toBe(4);
    expect(exitCodeFor(receipt('completed', { proof: { verification: null, unavailable: 'the proof service answered 503' }, effect: CONFIRMED }))).toBe(4);
  });

  it('a proof the Accumulate side cannot be checked from is 5', () => {
    const r = receipt('completed', {
      proof: { verification: verification('no_evidence', []), notServed: { code: 'PROOF_V2_EVIDENCE_NOT_SERVED', reason: 'no portable document' } }, effect: CONFIRMED,
    });
    expect(r.verdict).toBe('partial');
    expect(exitCodeFor(r)).toBe(5);
  });

  it('a verified proof whose recipient balance did not rise is 4, not 0', () => {
    const r = receipt('completed', {
      proof: { verification: verification('verified', [layer('trust', 'verified'), layer('outcome', 'verified')]), nodeConsulted: true },
      effect: { kind: 'native_transfer', state: 'not_observed', amount: '0.0001', detail: 'The recipient\'s balance changed by 0 ETH, not the 0.0001 sent.' },
    });
    expect(exitCodeFor(r)).toBe(4);
  });
});

describe('stageLine', () => {
  it('reads as four labelled marks, in order, with the destination chain named', () => {
    expect(stageLine(VERIFIED())).toBe('[done] signed  [done] anchored on Accumulate  [done] executed on base-sepolia  [done] proof verified locally');
  });

  it('marks what is unknown, pending and failed differently from done', () => {
    expect(stageLine(PARTIAL())).toBe('[done] signed  [done] anchored on Accumulate  [done] executed on base-sepolia  [ ?? ] proof verified locally');
    expect(stageLine(receipt('anchoring'))).toBe('[done] signed  [wait] anchored on Accumulate  [wait] executed on base-sepolia  [wait] proof verified locally');
    expect(stageLine(receipt('failed'))).toContain('[FAIL] executed');
  });
});

describe('receiptLines', () => {
  it('a verified receipt says VERIFIED, with the layer count, and offers to share it', () => {
    const text = receiptLines(VERIFIED(), { savedTo: '/home/x/.certen/receipts/r.json' }).join('\n');
    expect(text).toMatch(/Proof\s+VERIFIED: 3 of 3 layers carried, checked here/);
    expect(text).toMatch(/Saved\s+\/home\/x\/\.certen\/receipts\/r\.json/);
    expect(text).not.toMatch(/Not established/);
    expect(text).toMatch(/Next: certen receipt 7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b13 --share/);
  });

  it('keeps every id in full, and names where the destination hash came from', () => {
    const text = receiptLines(VERIFIED()).join('\n');
    expect(text).toContain(`intent          ${INTENT}`);
    expect(text).toContain(`accumulate tx   acc://${'ab'.repeat(32)}@sign-test.acme/data`);
    expect(text).toContain(`base-sepolia tx ${TX_HASH}   (from the verified proof)`);
    expect(text).toContain(`https://sepolia.basescan.org/tx/${TX_HASH}`);
    expect(text).toContain('Sent      0.0001 ETH on base-sepolia: 0xAbstract -> 0x1111111111111111111111111111111111111111');
  });

  it('a PARTIAL receipt is never dressed as verified: it says PARTIAL, lists what is not established, and names the way forward', () => {
    const text = receiptLines(PARTIAL()).join('\n');
    expect(text).not.toMatch(/VERIFIED/);
    expect(text).toMatch(/Proof\s+PARTIAL: 1 of 3 layers carried are established; G1_chains, outcome are not\./);
    expect(text).toMatch(/Not established:/);
    expect(text).toMatch(/- Layer G1_chains \(G1_chains\): 3 of 3 pages' chains are not bound/);
    expect(text).toMatch(/Next: certen receipt 7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b13 --rpc <a node you trust on base-sepolia>/);
  });

  it('a verified proof with a recipient that did not receive it shows both lines: the proof, and the overall reading', () => {
    const r = receipt('completed', {
      proof: { verification: verification('verified', [layer('trust', 'verified'), layer('outcome', 'verified')]), nodeConsulted: true },
      effect: { kind: 'native_transfer', state: 'not_observed', amount: '0.0001', detail: 'The recipient\'s balance changed by 0 ETH, not the 0.0001 sent.' },
    });
    const text = receiptLines(r).join('\n');
    expect(text).toMatch(/Proof\s+VERIFIED: 2 of 2 layers carried/);
    expect(text).toMatch(/Result\s+PARTIAL: the proof verifies, but the recipient's balance did not rise as expected/);
  });

  it('a failed intent shows why, on the executed stage and in the result', () => {
    const r = receipt('failed', { extra: { reason_code: 'target_reverted', error_message: 'the call reverted' } });
    const text = receiptLines(r).join('\n');
    expect(text).toContain('[FAIL] executed on base-sepolia');
    expect(text).toMatch(/Result\s+FAILED: the intent failed/);
    expect(text).not.toMatch(/Next:/);
  });

  it('a pending intent points at `watch`; one that executed with its proof still coming points at `receipt`', () => {
    expect(receiptLines(receipt('anchoring')).join('\n')).toContain(`Next: certen watch ${INTENT}`);
    expect(receiptLines(receipt('executed')).join('\n')).toContain(`Next: certen receipt ${INTENT}`);
    expect(nextCommand(receipt('failed'))).toBeUndefined();
  });

  it('an intent with no request on record has no Sent line, and says so about its effect', () => {
    const text = receiptLines(receipt('completed', { request: null, proof: { verification: verification('verified', [layer('trust', 'verified')]), nodeConsulted: true } })).join('\n');
    expect(text).not.toMatch(/^\s+Sent /m);
    expect(text).toMatch(/Effect\s+There is no request on record to check an effect against\./);
  });

  it('a contract call shows what was called', () => {
    const call: ReceiptRequest = { ...REQUEST, kind: 'contract_call', amount: null, asset: null, contract_call: { target: `0x${'be'.repeat(20)}`, function_signature: 'confirm(bytes32)', value_wei: '0' } };
    expect(receiptLines(receipt('anchoring', { request: call })).join('\n')).toContain(`Called    confirm(bytes32) on 0x${'be'.repeat(20)} (base-sepolia)`);
  });
});

describe('--explain: the proof layer by layer', () => {
  it('prints every layer with its verdict, the evidence for a verified one and the reason for the others', () => {
    const text = receiptLines(PARTIAL(), { explain: true }).join('\n');
    expect(text).toContain('The proof, layer by layer (checked here, from the proof\'s own bytes; the bundle\'s own "verified" is never used):');
    expect(text).toMatch(/trust\s+verified\s+Layer trust {2}\(S1\)/);
    expect(text).toMatch(/block 46437431 · root 0xaaaaaaaaaa…aaaaaa/);
    expect(text).toMatch(/G1_chains\s+NOT CHECKED\s+Layer G1_chains/);
    expect(text).toContain('3 of 3 pages\' chains are not bound');
    expect(text).toContain('Layers carried: 3, verified here: 1, not carried by this document: 0.');
    expect(text).toContain('NOT compared with a node of yours');
    expect(text).toContain('A valid proof of the WRONG call is still a valid proof');
  });

  it('says the execution layer was compared when the caller\'s node was consulted', () => {
    const text = receiptLines(VERIFIED(), { explain: true }).join('\n');
    expect(text).toContain('The execution layer was compared with a header from the node you gave.');
    expect(text).not.toContain('NOT compared');
  });

  it('counts a layer the document does not carry separately from one that failed to verify', () => {
    const r = receipt('completed', {
      proof: { verification: verification('verified', [layer('trust', 'verified'), layer('G2', 'not_in_document', 'the document carries a hash, not the evidence')]), nodeConsulted: true },
      effect: CONFIRMED,
    });
    const text = receiptLines(r, { explain: true }).join('\n');
    expect(text).toMatch(/G2\s+not carried\s+Layer G2/);
    expect(text).toContain('Layers carried: 1, verified here: 1, not carried by this document: 1.');
  });

  it('without a proof, explains why instead of printing an empty table', () => {
    expect(receiptLines(receipt('anchoring'), { explain: true }).join('\n')).toContain('The intent has not finished, so there is nothing to prove yet.');
  });
});

describe('proofLine', () => {
  it('uses capitals only where the proof is not a pass', () => {
    expect(proofLine(VERIFIED())).toMatch(/^VERIFIED: 3 of 3 layers carried, checked here/);
    expect(proofLine(PARTIAL())).toMatch(/^PARTIAL: /);
    expect(proofLine(receipt('completed', { proof: { verification: null, unavailable: 'down' }, effect: CONFIRMED }))).toMatch(/^NOT CHECKED: /);
    expect(proofLine(receipt('completed', { proof: { verification: verification('failed', [layer('L1', 'failed', 'bad')]) }, effect: CONFIRMED }))).toMatch(/^FAILED: /);
    expect(proofLine(receipt('anchoring'))).toBe('The intent has not finished, so there is nothing to prove yet.');
  });
});
