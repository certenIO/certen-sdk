import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  CertenClient, assembleReceipt, estimateFee, describeReasonCode, RECEIPT_VERSION, EXECUTION_SKU,
  type Receipt, type ReceiptProofInput, type ReceiptRequest, type ReceiptEffect, type RecipientSnapshot, type TransactionResponse, type VerificationLike,
} from '../src/index.js';

/**
 * The receipt: one record of what happened, whose verdict is the weakest honest reading of everything known.
 *
 * `assembleReceipt` is pure, so these tests feed it every shape a gateway status and a verification can take and pin the rules that matter
 * when a person reads the result as "did my money move, and can I show it":
 *
 *  - PARTIAL and NO EVIDENCE are never VERIFIED, and every missing layer is named;
 *  - a proof that could not be fetched is a gap, not a pass;
 *  - the destination transaction comes from the verified proof, then the validators' record, and is otherwise absent: it is never invented;
 *  - refreshing a receipt keeps what was asked and when, and replaces what was uncertain.
 */

const INTENT = '7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b13';
const ACCUM = 'ab'.repeat(32);
const DEST_PROOF = `0x${'11'.repeat(32)}`;
const DEST_VALIDATORS = `0x${'22'.repeat(32)}`;
const T0 = new Date('2026-10-15T10:00:00.000Z');
const T1 = new Date('2026-10-15T10:05:00.000Z');

const tx = (status: string, extra: Record<string, unknown> = {}): TransactionResponse =>
  ({ intent_id: INTENT, identity_id: 'id-1', status, created_at: '2026-10-15T09:59:00Z', ...extra }) as unknown as TransactionResponse;

const layer = (id: string, verdict: 'verified' | 'failed' | 'not_checked' | 'not_in_document', reason?: string) =>
  ({ id, title: `Layer ${id}`, verdict, ...(reason ? { reason } : {}) });

const ALL_VERIFIED = [layer('trust', 'verified'), layer('L1', 'verified'), layer('G1', 'verified'), layer('govroot', 'verified'), layer('outcome', 'verified')];

const verification = (overall: VerificationLike['overall'], layers = ALL_VERIFIED, extra: Partial<VerificationLike> = {}): VerificationLike => ({
  overall, layers, evidenceFound: true,
  execution: { ok: true, txHash: DEST_PROOF, blockNumber: 46437431, chainId: '84532' },
  headerCheck: { ok: true },
  ...extra,
});

const verifiedProof = (over: Partial<ReceiptProofInput> = {}): ReceiptProofInput => ({ verification: verification('verified'), nodeConsulted: true, ...over });

const REQUEST: ReceiptRequest = {
  kind: 'transfer', chain: 'base-sepolia', chain_id: 84532, identity_id: 'id-1', adi_url: 'acc://jason-dev.acme',
  from: `0x${'aa'.repeat(20)}`, to: `0x${'bb'.repeat(20)}`, amount: '0.0001', asset: 'ETH', contract_call: null,
};

const effect = (state: ReceiptEffect['state']): ReceiptEffect => ({ kind: 'native_transfer', state, detail: `the effect is ${state}`, amount: '0.0001', symbol: 'ETH' });

const assemble = (status: string, over: Partial<Parameters<typeof assembleReceipt>[0]> = {}, txExtra: Record<string, unknown> = {}): Receipt =>
  assembleReceipt({ intentId: INTENT, transaction: tx(status, { accum_tx_hash: `acc://${ACCUM}@jason-dev.acme/data`, ...txExtra }), request: REQUEST, now: () => T0, ...over });

const REGISTRY = {
  accumulate: { network: 'kermit', environment: 'testnet', api: 'http://x/v3', explorer: 'https://explorer.accumulatenetwork.io' },
  chains: [
    { id: 'base-sepolia', chainId: 84532, family: 'evm', displayName: 'Base Sepolia', environment: 'testnet', explorer: 'https://sepolia.basescan.org/', status: 'live', contracts: {} },
    { id: 'solana-devnet', chainId: null, family: 'solana', displayName: 'Solana', environment: 'testnet', explorer: 'https://explorer.solana.com', status: 'live', contracts: {} },
    { id: 'ethereum-sepolia', chainId: 11155111, family: 'evm', displayName: 'Ethereum Sepolia', environment: 'testnet', explorer: '', status: 'live', contracts: {} },
  ],
};

const stageStates = (r: Receipt): string[] => r.stages.map((s) => `${s.id}:${s.state}`);
const codes = (r: Receipt): string[] => r.gaps.map((g) => g.code);

describe('assembleReceipt: what each gateway status means for the verdict', () => {
  it('is version 1 and carries the documented top-level fields', () => {
    const r = assemble('completed', { proof: verifiedProof() });
    expect(RECEIPT_VERSION).toBe(1);
    expect(r.receipt_version).toBe(1);
    expect(Object.keys(r).sort()).toEqual([
      'created_at', 'effect', 'gaps', 'gateway', 'headline', 'ids', 'intent_id', 'kind', 'links', 'proof', 'receipt_version', 'recipient_snapshot',
      'request', 'signed_with', 'stages', 'status', 'updated_at', 'verdict',
    ]);
  });

  const IN_FLIGHT: Array<[string, string[]]> = [
    ['created', ['signed:pending', 'anchored:skipped', 'executed:pending', 'proof_verified:pending']],
    ['signing_required', ['signed:pending', 'anchored:skipped', 'executed:pending', 'proof_verified:pending']],
    ['submitted', ['signed:done', 'anchored:pending', 'executed:pending', 'proof_verified:pending']],
    ['processing', ['signed:done', 'anchored:pending', 'executed:pending', 'proof_verified:pending']],
    ['anchoring', ['signed:done', 'anchored:pending', 'executed:pending', 'proof_verified:pending']],
  ];
  for (const [status, stages] of IN_FLIGHT) {
    it(`${status} is pending, not finished, with nothing to prove yet`, () => {
      const r = assemble(status);
      expect(r.verdict).toBe('pending');
      expect(r.status).toMatchObject({ gateway_status: status, class: 'in_flight', outcome: 'pending', terminal: false });
      expect(stageStates(r)).toEqual(stages);
      expect(codes(r)).toEqual(['INTENT_NOT_TERMINAL']);
      expect(r.proof.verdict).toBe('pending');
      expect(r.headline).toMatch(/^PENDING/);
    });
  }

  it('executed is pending, with the proof still being produced (the action ran; that is not a failure and not yet verified)', () => {
    const r = assemble('executed');
    expect(r.verdict).toBe('pending');
    expect(r.status.outcome).toBe('executed');
    expect(stageStates(r)).toEqual(['signed:done', 'anchored:done', 'executed:done', 'proof_verified:pending']);
    expect(codes(r)).toEqual(['PROOF_PENDING']);
    expect(r.headline).toBe('PENDING: executed; the proof is still being produced');
  });

  for (const status of ['completed', 'proven', 'delivered']) {
    it(`${status} with a verified proof is verified, every stage done and no gap`, () => {
      const r = assemble(status, { proof: verifiedProof(), effect: effect('confirmed') });
      expect(r.verdict).toBe('verified');
      expect(stageStates(r)).toEqual(['signed:done', 'anchored:done', 'executed:done', 'proof_verified:done']);
      expect(r.gaps).toEqual([]);
      expect(r.headline).toBe('VERIFIED: 5 of 5 layers carried, checked here');
      expect(r.proof).toMatchObject({ verdict: 'verified', checked_here: true, node_checked: true, layers_total: 5, layers_verified: 5 });
    });
  }

  it('completed_unproven is "unproven": executed, nothing can be verified, and it says so rather than reading as verified or as a failure', () => {
    const r = assemble('completed_unproven', { proof: verifiedProof() });
    expect(r.verdict).toBe('unproven');
    expect(r.status).toMatchObject({ outcome: 'completed_unproven', reason: 'execution_proof_unavailable', terminal: true });
    expect(r.proof.verdict).toBe('not_applicable');
    expect(r.proof.checked_here).toBe(false);
    expect(stageStates(r)).toEqual(['signed:done', 'anchored:done', 'executed:done', 'proof_verified:skipped']);
    expect(r.gaps).toEqual([]);
    expect(r.headline).toMatch(/^EXECUTED, NOT PROVABLE/);
  });

  for (const status of ['failed', 'expired', 'error']) {
    it(`${status} is failed; the execution stage carries the reason and the proof is not applicable`, () => {
      const reason = status === 'expired' ? 'expired' : null;
      const r = assemble(status, {}, { reason_code: reason, error_message: 'the gateway said no' });
      expect(r.verdict).toBe('failed');
      expect(r.proof.verdict).toBe('not_applicable');
      expect(r.status.class).toBe('terminal_failure');
      const executed = r.stages.find((s) => s.id === 'executed')!;
      expect(executed.state).toBe('failed');
      expect(executed.detail).toBe(reason ? describeReasonCode(reason) : 'the gateway said no');
      expect(r.stages.find((s) => s.id === 'proof_verified')!.state).toBe('skipped');
      expect(r.headline).toMatch(new RegExp(`^FAILED: the intent ${status}`));
    });
  }

  it('a failure before any Accumulate transaction was recorded does not claim it was signed', () => {
    const r = assembleReceipt({ intentId: INTENT, transaction: tx('failed', { accum_tx_hash: null }), request: REQUEST, now: () => T0 });
    expect(stageStates(r)).toEqual(['signed:unknown', 'anchored:skipped', 'executed:failed', 'proof_verified:skipped']);
  });

  it('a failure after one was recorded says the anchoring is not known, rather than done', () => {
    const r = assemble('failed');
    expect(stageStates(r)).toEqual(['signed:done', 'anchored:unknown', 'executed:failed', 'proof_verified:skipped']);
  });

  it('a status this client does not recognise is pending and unknown, never terminal and never done', () => {
    const r = assemble('wibbling');
    expect(r.verdict).toBe('pending');
    expect(r.status).toMatchObject({ gateway_status: 'wibbling', class: 'unknown', outcome: 'unknown', terminal: false });
    expect(codes(r)).toEqual(['INTENT_NOT_TERMINAL']);
    expect(r.gaps[0]!.text).toMatch(/still wibbling/);
    expect(r.stages.find((s) => s.id === 'executed')!.state).toBe('pending');
  });

  it('an empty status is pending and says "unknown", and has not been signed', () => {
    const r = assemble('');
    expect(r.verdict).toBe('pending');
    expect(r.stages[0]!.state).toBe('pending');
    expect(r.gaps[0]!.text).toMatch(/still unknown/);
  });

  it('carries the gateway\'s reason_code, completion_basis and the validators\' state through to status', () => {
    const r = assemble('completed', {
      proof: verifiedProof(),
    }, { reason_code: null, completion_basis: 'proof_artifact', validator: { state: 'settled', members: [] } });
    expect(r.status).toMatchObject({ completion_basis: 'proof_artifact', validator_state: 'settled', reason_code: null });
  });
});

describe('assembleReceipt: the proof is never softened', () => {
  it('a PARTIAL proof is a partial receipt, never verified, and every layer that is not established is named', () => {
    const layers = [layer('trust', 'verified'), layer('G1', 'not_checked', 'the validator set is not bound'), layer('outcome', 'not_checked', 'the receipts root is the validators\' statement')];
    const r = assemble('completed', { proof: { verification: verification('partial', layers, { headerCheck: null }), nodeConsulted: false }, effect: effect('unchecked') });
    expect(r.verdict).toBe('partial');
    expect(r.proof).toMatchObject({ verdict: 'partial', layers_total: 3, layers_verified: 1, node_checked: false });
    expect(r.proof.not_established.map((l) => l.id)).toEqual(['G1', 'outcome']);
    expect(r.headline).toMatch(/^PARTIAL: 1 of 3 layers carried are established; G1, outcome are not\./);
    // The execution layer's own reason is the node gap (it names the cause and what to do); listing it twice would be the same fact twice.
    const notEstablished = r.gaps.filter((g) => g.code === 'PROOF_LAYER_NOT_ESTABLISHED');
    expect(notEstablished.map((g) => g.text)).toEqual(['Layer G1 (G1): the validator set is not bound']);
    expect(codes(r)).toContain('NODE_NOT_CONSULTED');
    expect(r.stages.find((s) => s.id === 'proof_verified')!.state).toBe('unknown');
  });

  it('says "is" for one missing layer and "are" for several', () => {
    const one = assemble('completed', { proof: { verification: verification('partial', [layer('a', 'verified'), layer('b', 'not_checked', 'x')]) } });
    expect(one.headline).toMatch(/b is not\./);
  });

  it('does not ask for a node when the layer that is missing is not the execution layer', () => {
    const r = assemble('completed', { proof: { verification: verification('partial', [layer('trust', 'verified'), layer('G1', 'not_checked', 'unbound'), layer('outcome', 'verified')]), nodeConsulted: true }, effect: effect('confirmed') });
    expect(codes(r)).toEqual(['PROOF_LAYER_NOT_ESTABLISHED']);
  });

  it('does not count a layer the document does not carry against the proof, and counts it in layers_not_carried', () => {
    const r = assemble('completed', { proof: verifiedProof({ verification: verification('verified', [layer('trust', 'verified'), layer('G2', 'not_in_document'), layer('outcome', 'verified')]) }), effect: effect('confirmed') });
    expect(r.proof).toMatchObject({ layers_total: 2, layers_verified: 2, layers_not_carried: 1 });
    expect(r.verdict).toBe('verified');
    expect(r.headline).toBe('VERIFIED: 2 of 2 layers carried, checked here');
  });

  it('NO EVIDENCE is a partial receipt that says so, and carries why nothing was served', () => {
    const r = assemble('completed', {
      proof: { verification: verification('no_evidence', [layer('trust', 'not_checked', 'no document')], { evidenceFound: false, execution: null, headerCheck: null }),
        notServed: { code: 'PROOF_V2_EVIDENCE_NOT_SERVED', reason: 'the gateway holds no portable document' } },
    });
    expect(r.verdict).toBe('partial');
    expect(r.proof.verdict).toBe('no_evidence');
    expect(r.proof.evidence).toEqual({ found: false, code: 'PROOF_V2_EVIDENCE_NOT_SERVED', reason: 'the gateway holds no portable document' });
    expect(codes(r)).toContain('PROOF_NO_EVIDENCE');
    expect(r.headline).toMatch(/^NO EVIDENCE: PROOF_V2_EVIDENCE_NOT_SERVED/);
  });

  it('a proof layer that was checked and does not hold fails the receipt, with the layer and the warning', () => {
    const r = assemble('completed', {
      proof: { verification: verification('failed', [layer('trust', 'verified'), layer('G1', 'failed', 'bad signature')], { failure: { layer: 'G1', message: 'bad signature' } }) },
      effect: effect('confirmed'),
    });
    expect(r.verdict).toBe('failed');
    expect(r.proof.verdict).toBe('failed');
    expect(codes(r)).toContain('PROOF_LAYER_FAILED');
    expect(r.headline).toBe('FAILED: A layer was checked and does not hold: G1: bad signature. Do not rely on this proof.');
    expect(r.stages.find((s) => s.id === 'proof_verified')!.state).toBe('failed');
  });

  it('a proof that could not be fetched is a gap and a partial receipt, never a pass', () => {
    const r = assemble('completed', { proof: { verification: null, unavailable: 'the proof service answered 502' } });
    expect(r.verdict).toBe('partial');
    expect(r.proof).toMatchObject({ verdict: 'unavailable', checked_here: false, node_checked: false });
    expect(r.proof.detail).toBe('The proof could not be checked: the proof service answered 502.');
    expect(codes(r)).toContain('PROOF_NOT_FETCHED');
    expect(r.proof.evidence).toMatchObject({ found: false, reason: 'the proof service answered 502' });
  });

  it('a completed intent with no verification at all says no verification was made', () => {
    const r = assemble('completed');
    expect(r.verdict).toBe('partial');
    expect(r.proof.detail).toBe('The proof could not be checked: no verification was made.');
  });

  it('node_checked needs a node that was consulted AND a header comparison to have been made', () => {
    expect(assemble('completed', { proof: verifiedProof({ nodeConsulted: true }) }).proof.node_checked).toBe(true);
    expect(assemble('completed', { proof: verifiedProof({ nodeConsulted: false }) }).proof.node_checked).toBe(false);
    expect(assemble('completed', { proof: { verification: verification('verified', ALL_VERIFIED, { headerCheck: null }), nodeConsulted: true } }).proof.node_checked).toBe(false);
  });

  it('a node that was given and could not be used is named in the gap', () => {
    const layers = [layer('trust', 'verified'), layer('outcome', 'not_checked', 'validators\' statement')];
    const r = assemble('completed', { proof: { verification: verification('partial', layers, { headerCheck: null }), nodeConsulted: false, nodeError: 'the node at rpc.example did not answer within 10s (eth_getBlockByNumber).' } });
    const gap = r.gaps.find((g) => g.code === 'NODE_NOT_CONSULTED')!;
    expect(gap.text).toContain('The node you gave could not be used');
    expect(gap.text).toContain('rpc.example did not answer within 10s');
  });

  it('without a node, the gap says the execution layer rests on the validators\' own statement', () => {
    const layers = [layer('trust', 'verified'), layer('outcome', 'not_checked', 'validators\' statement')];
    const r = assemble('completed', { proof: { verification: verification('partial', layers, { headerCheck: null }), nodeConsulted: false } });
    expect(r.gaps.find((g) => g.code === 'NODE_NOT_CONSULTED')!.text).toMatch(/validators' own statement/);
  });

  it('keeps the layer statement and evidence for --explain', () => {
    const layers = [{ id: 'outcome', title: 'Execution', verdict: 'verified' as const, statement: 'S6', evidence: { block: 46437431 } }, layer('trust', 'verified')];
    const r = assemble('completed', { proof: verifiedProof({ verification: verification('verified', layers) }), effect: effect('confirmed') });
    expect(r.proof.layers[0]).toMatchObject({ id: 'outcome', statement: 'S6', evidence: { block: 46437431 } });
    // An empty evidence object is noise and is left out.
    expect(r.proof.layers[1]).not.toHaveProperty('evidence');
  });
});

describe('assembleReceipt: the effect and the verdict', () => {
  const proof = verifiedProof();

  it('a verified proof with a recipient balance that did not rise is partial, and the receipt says why', () => {
    const r = assemble('completed', { proof, effect: effect('not_observed') });
    expect(r.verdict).toBe('partial');
    expect(codes(r)).toEqual(['EFFECT_NOT_OBSERVED']);
    expect(r.headline).toBe('PARTIAL: the proof verifies, but the recipient\'s balance did not rise as expected');
  });

  it('a verified proof with a confirmed effect is verified and has no gap', () => {
    const r = assemble('completed', { proof, effect: effect('confirmed') });
    expect(r.verdict).toBe('verified');
    expect(r.gaps).toEqual([]);
  });

  // What the code ACTUALLY does with an effect that is unchecked or unreadable: the verdict stays verified (only `not_observed` demotes it) and
  // the gap is recorded, so the receipt is "verified, with this not checked". The doc comment on `gaps` says it is empty exactly when verified;
  // that is the one sentence these two cases contradict.
  it('a verified proof with an UNCHECKED effect is PARTIAL: unknown is not ok, and the gap says which', () => {
    const r = assemble('completed', { proof, effect: effect('unchecked') });
    expect(r.verdict).toBe('partial');
    expect(r.headline).toBe('PARTIAL: the proof verifies, but the recipient\'s balance was not checked');
    expect(codes(r)).toEqual(['EFFECT_UNCHECKED']);
    expect(r.gaps[0]!.text).toBe('the effect is unchecked');
  });

  it('a verified proof with an UNREADABLE effect is PARTIAL, and says it could not be read (not that it did not rise)', () => {
    const r = assemble('completed', { proof, effect: effect('unreadable') });
    expect(r.verdict).toBe('partial');
    expect(r.headline).toBe('PARTIAL: the proof verifies, but the recipient\'s balance could not be read');
    expect(codes(r)).toEqual(['EFFECT_UNREADABLE']);
  });

  it('the gaps are empty exactly when the verdict is verified', () => {
    const verified = assemble('completed', { proof, effect: effect('confirmed') });
    expect(verified.verdict).toBe('verified');
    expect(verified.gaps).toEqual([]);
    // Nothing to compare (a call with no expected event, or an intent with no request on record) is not a gap.
    const none = assemble('completed', { proof, effect: { kind: 'none', state: 'not_applicable', detail: 'no balance to compare' } });
    expect(none.verdict).toBe('verified');
    expect(none.gaps).toEqual([]);
  });

  it('an effect on something that has not completed adds no gap: the intent\'s own gap is the one that matters', () => {
    const r = assemble('executed', { effect: effect('unchecked') });
    expect(codes(r)).toEqual(['PROOF_PENDING']);
  });

  it('with no effect given it says what was not checked for a transfer, a call and an unknown request', () => {
    // A transfer whose effect nobody supplied is UNCHECKED, not "not applicable": a transfer has an effect, and it was not looked at.
    const transfer = assemble('completed', { proof });
    expect(transfer.effect).toMatchObject({ kind: 'native_transfer', state: 'unchecked', amount: '0.0001', detail: 'The effect of this transfer was not checked.' });
    expect(transfer.verdict).toBe('partial');
    const call: ReceiptRequest = { ...REQUEST, kind: 'contract_call', amount: null, contract_call: { target: `0x${'cc'.repeat(20)}`, function_signature: 'confirm(bytes32)', value_wei: '0' } };
    expect(assemble('completed', { proof, request: call }).effect.detail).toMatch(/A contract call has no balance to compare/);
    expect(assembleReceipt({ intentId: INTENT, transaction: tx('completed'), now: () => T0 }).effect.detail).toMatch(/no request on record/);
  });
});

describe('assembleReceipt: the ids, and where each came from', () => {
  it('takes the destination transaction from the verified execution proof in preference to the validators\' record', () => {
    const r = assemble('completed', {
      proof: verifiedProof(), effect: effect('confirmed'),
    }, { validator: { state: 'settled', members: [{ chain_id: 84532, settlement_tx: DEST_VALIDATORS }] } });
    expect(r.ids).toMatchObject({ destination_tx: DEST_PROOF, destination_tx_source: 'proof', destination_block: 46437431, destination_chain: 'base-sepolia' });
  });

  it('falls back to the validators\' settlement transaction, and says that is where it came from', () => {
    const r = assemble('executed', {}, { validator: { state: 'executed_proof_pending', members: [{ chain_id: 84532, settlement_tx: DEST_VALIDATORS }] } });
    expect(r.ids).toMatchObject({ destination_tx: DEST_VALIDATORS, destination_tx_source: 'validators', destination_block: null });
    expect(r.stages.find((s) => s.id === 'executed')!.detail).toBe(DEST_VALIDATORS);
  });

  it('ignores an execution proof that did not verify, rather than taking its transaction hash', () => {
    const bad = verification('failed', [layer('outcome', 'failed', 'bad')], { execution: { ok: false, txHash: DEST_PROOF, blockNumber: 1, chainId: '84532' }, failure: { layer: 'outcome', message: 'bad' } });
    const r = assemble('completed', { proof: { verification: bad } });
    expect(r.ids.destination_tx).toBeNull();
    expect(r.ids.destination_tx_source).toBeNull();
    expect(r.ids.destination_block).toBeNull();
  });

  it('has no destination transaction when nothing says what it was, and never invents one', () => {
    const r = assemble('anchoring');
    expect(r.ids).toMatchObject({ destination_tx: null, destination_tx_source: null, destination_block: null });
    expect(r.links.destination_tx).toBeNull();
  });

  it('extracts the 64-hex Accumulate transaction hash from the acc:// form, lower-cased', () => {
    const r = assembleReceipt({ intentId: INTENT, transaction: tx('submitted', { accum_tx_hash: `acc://${ACCUM.toUpperCase()}@jason-dev.acme/data` }), request: REQUEST, now: () => T0 });
    expect(r.ids.accumulate_tx).toBe(`acc://${ACCUM.toUpperCase()}@jason-dev.acme/data`);
    expect(r.ids.accumulate_tx_hash).toBe(ACCUM);
  });

  it('keeps the whole accum_tx_hash string but reads no hash out of one that has none', () => {
    const r = assembleReceipt({ intentId: INTENT, transaction: tx('submitted', { accum_tx_hash: 'acc://not-a-hash@x.acme/data' }), request: REQUEST, now: () => T0 });
    expect(r.ids.accumulate_tx).toBe('acc://not-a-hash@x.acme/data');
    expect(r.ids.accumulate_tx_hash).toBeNull();
    expect(assembleReceipt({ intentId: INTENT, transaction: tx('created'), now: () => T0 }).ids).toMatchObject({ accumulate_tx: null, accumulate_tx_hash: null });
  });

  it('reads the proof id and the write-back transaction from the intent, from proofs[] first and then from the validators', () => {
    const fromProofs = assemble('completed', { proof: verifiedProof() }, { proof_id: 'proof-1', proofs: [{ chain_id: 84532, proof_id: 'proof-1', write_back_tx: '0xwb1' }] });
    expect(fromProofs.ids).toMatchObject({ proof_id: 'proof-1', write_back_tx: '0xwb1' });
    expect(fromProofs.proof.proof_id).toBe('proof-1');
    const fromMembers = assemble('executed', {}, { validator: { state: 'settled', members: [{ chain_id: 84532, write_back_tx: '0xwb2' }] } });
    expect(fromMembers.ids.write_back_tx).toBe('0xwb2');
    // An empty proof_id (what a proof-less intent carries on the live gateway) is no proof id.
    expect(assemble('completed', {}, { proof_id: '' }).ids.proof_id).toBeNull();
  });

  it('takes the destination chain from the request, else from the execution proof, else from the validators', () => {
    const noRequest = (extra: Record<string, unknown>, proof?: ReceiptProofInput) => assembleReceipt({ intentId: INTENT, transaction: tx('completed', extra), proof, now: () => T0 });
    expect(noRequest({}, verifiedProof()).ids.destination_chain).toBe('base-sepolia');
    expect(noRequest({ validator: { state: 'settled', members: [{ chain_id: 11155111 }] } }).ids.destination_chain).toBe('ethereum-sepolia');
    expect(noRequest({}).ids.destination_chain).toBeNull();
    // The request wins over what a proof says: it is what was asked for.
    expect(assemble('completed', { request: { ...REQUEST, chain: 'arbitrum-sepolia' }, proof: verifiedProof() }).ids.destination_chain).toBe('arbitrum-sepolia');
  });
});

describe('assembleReceipt: links', () => {
  const ready = (over: Partial<Parameters<typeof assembleReceipt>[0]> = {}): Receipt =>
    assemble('completed', { proof: verifiedProof(), effect: effect('confirmed'), registry: REGISTRY, ...over });

  it('links the destination transaction on an EVM chain\'s explorer, with the trailing slash tidied', () => {
    expect(ready().links.destination_tx).toBe(`https://sepolia.basescan.org/tx/${DEST_PROOF}`);
  });

  it('always names the Accumulate explorer, but never guesses a path on it', () => {
    expect(ready().links.accumulate_explorer).toBe('https://explorer.accumulatenetwork.io');
  });

  it('gives no link for a chain that is not EVM, one with no explorer, a chain the registry lacks, or no registry', () => {
    expect(ready({ request: { ...REQUEST, chain: 'solana-devnet' } }).links.destination_tx).toBeNull();
    expect(ready({ request: { ...REQUEST, chain: 'ethereum-sepolia' } }).links.destination_tx).toBeNull();
    expect(ready({ request: { ...REQUEST, chain: 'arbitrum-sepolia' } }).links.destination_tx).toBeNull();
    const none = ready({ registry: null });
    expect(none.links).toEqual({ destination_tx: null, accumulate_explorer: null });
  });
});

describe('assembleReceipt: refreshing a receipt', () => {
  const SNAPSHOT: RecipientSnapshot = { address: REQUEST.to!, wei: '5000000000000000', host: 'rpc.example', chain_id: 84532, taken_at: '2026-10-15T09:58:00.000Z' };

  it('keeps when it was created, what was asked, who signed, the gateway and the pre-signing balance, and moves updated_at', () => {
    const first = assemble('anchoring', {
      gateway: 'https://gateway.example', signedWith: { key: 'dev', public_key_hash: 'ff'.repeat(32) }, snapshot: SNAPSHOT,
    });
    expect(first).toMatchObject({ created_at: T0.toISOString(), updated_at: T0.toISOString() });

    const later = assembleReceipt({
      intentId: INTENT, transaction: tx('completed', { accum_tx_hash: `acc://${ACCUM}@jason-dev.acme/data`, proof_id: 'proof-1' }),
      previous: first, proof: verifiedProof(), effect: effect('confirmed'), now: () => T1,
    });
    expect(later.created_at).toBe(T0.toISOString());
    expect(later.updated_at).toBe(T1.toISOString());
    expect(later.request).toEqual(REQUEST);
    expect(later.kind).toBe('transfer');
    expect(later.signed_with).toEqual({ key: 'dev', public_key_hash: 'ff'.repeat(32) });
    expect(later.gateway).toBe('https://gateway.example');
    expect(later.recipient_snapshot).toEqual(SNAPSHOT);
    expect(later.verdict).toBe('verified');
  });

  it('replaces what was uncertain with what is now known, but remembers a destination it already had', () => {
    const first = assemble('executed', { effect: effect('unchecked') }, { validator: { state: 'executed_proof_pending', members: [{ chain_id: 84532, settlement_tx: DEST_VALIDATORS }] } });
    expect(first.ids.destination_tx_source).toBe('validators');
    // A later read that no longer shows the validators' record still keeps the destination the receipt already had.
    const again = assembleReceipt({ intentId: INTENT, transaction: tx('executed'), previous: first, now: () => T1 });
    expect(again.ids).toMatchObject({ destination_tx: DEST_VALIDATORS, destination_tx_source: 'validators' });
    // And the verified proof then replaces it, with its own source.
    const done = assembleReceipt({ intentId: INTENT, transaction: tx('completed'), previous: again, proof: verifiedProof(), effect: effect('confirmed'), now: () => T1 });
    expect(done.ids).toMatchObject({ destination_tx: DEST_PROOF, destination_tx_source: 'proof' });
  });

  it('a previous receipt\'s effect is kept when no new one is given', () => {
    const first = assemble('completed', { proof: verifiedProof(), effect: effect('confirmed') });
    const again = assembleReceipt({ intentId: INTENT, transaction: tx('completed'), previous: first, proof: verifiedProof(), now: () => T1 });
    expect(again.effect.state).toBe('confirmed');
    expect(again.verdict).toBe('verified');
  });
});

// ── estimateFee ─────────────────────────────────────────────────────────────────────────────────────

describe('estimateFee', () => {
  async function gateway(pricing: () => { status: number; body: unknown }) {
    const server = http.createServer((req, res) => {
      if ((req.url ?? '').split('?')[0] === '/v1/pricing') {
        const out = pricing();
        res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { client: new CertenClient({ apiKey: 'ck_live_test', baseUrl: url, maxRetries: 0 }), close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
  }

  const item = (over: Record<string, unknown>) => ({ sku: EXECUTION_SKU, chain: '*', mode: 'flat', platform_fee_usd: '0.040000', gas_buffer_bps: 0, min_charge_usd: '0', max_charge_usd: null, ...over });

  it('prefers the entry for the exact chain over the "*" fallback, and labels itself an estimate', async () => {
    const g = await gateway(() => ({ status: 200, body: { price_book_version: 'pb-7', price_book_hash: 'h', currency: 'USD', items: [item({ chain: '*', platform_fee_usd: '0.10' }), item({ chain: 'base-sepolia', platform_fee_usd: '0.04' })] } }));
    try {
      const f = await estimateFee(g.client, 'base-sepolia');
      expect(f).toMatchObject({ state: 'estimated', sku: 'proof.execute', chain: 'base-sepolia', platform_fee_usd: '0.04', mode: 'flat', price_book_version: 'pb-7' });
      expect(f.note).toMatch(/estimate from the price book, not a binding quote/);
    } finally { await g.close(); }
  });

  it('takes the numeric spelling of a chain as the same chain', async () => {
    const g = await gateway(() => ({ status: 200, body: { price_book_version: 'pb', price_book_hash: 'h', currency: 'USD', items: [item({ chain: 'base-sepolia', platform_fee_usd: '0.04' })] } }));
    try {
      expect((await estimateFee(g.client, '84532')).platform_fee_usd).toBe('0.04');
    } finally { await g.close(); }
  });

  it('uses the "*" entry when the chain has none of its own', async () => {
    const g = await gateway(() => ({ status: 200, body: { price_book_version: 'pb', price_book_hash: 'h', currency: 'USD', items: [item({ chain: '*', platform_fee_usd: '0.10' }), item({ sku: 'identity.provision', chain: 'base-sepolia', platform_fee_usd: '9' })] } }));
    try {
      expect((await estimateFee(g.client, 'base-sepolia')).platform_fee_usd).toBe('0.10');
    } finally { await g.close(); }
  });

  it('says a quoted item adds gas at execution, and carries the ceiling', async () => {
    const g = await gateway(() => ({ status: 200, body: { price_book_version: 'pb', price_book_hash: 'h', currency: 'USD', items: [item({ chain: 'base-sepolia', mode: 'quoted', max_charge_usd: '0.50' })] } }));
    try {
      const f = await estimateFee(g.client, 'base-sepolia');
      expect(f.mode).toBe('quoted');
      expect(f.max_charge_usd).toBe('0.50');
      expect(f.note).toMatch(/platform fee only. Gas is priced when it executes/);
    } finally { await g.close(); }
  });

  it('takes the gas reserve and symbol from the catalogue, labelled in the note as never a quote', async () => {
    const g = await gateway(() => ({ status: 200, body: { price_book_version: 'pb', price_book_hash: 'h', currency: 'USD', items: [item({})] } }));
    try {
      expect(await estimateFee(g.client, 'base-sepolia')).toMatchObject({ gas_reserve: '0.0001', gas_symbol: 'ETH' });
      expect(await estimateFee(g.client, 'ethereum-sepolia')).toMatchObject({ gas_reserve: '0.001', gas_symbol: 'ETH' });
      // A chain with no estimate has none: no number is made up for it.
      expect(await estimateFee(g.client, 'telcoin-adiri')).toMatchObject({ gas_reserve: null, gas_symbol: 'TEL' });
    } finally { await g.close(); }
  });

  it('is "unavailable", with no number, when the price book has no entry for the operation', async () => {
    const g = await gateway(() => ({ status: 200, body: { price_book_version: 'pb-7', price_book_hash: 'h', currency: 'USD', items: [item({ sku: 'identity.provision' })] } }));
    try {
      const f = await estimateFee(g.client, 'base-sepolia');
      expect(f).toMatchObject({ state: 'unavailable', platform_fee_usd: null, mode: null, max_charge_usd: null, price_book_version: 'pb-7' });
      expect(f.note).toMatch(/no proof\.execute entry for base-sepolia/);
    } finally { await g.close(); }
  });

  it('never throws: a price book that cannot be read is "unavailable" (a refused scope, a 500)', async () => {
    for (const status of [403, 500]) {
      const g = await gateway(() => ({ status, body: { message: 'no' } }));
      try {
        const f = await estimateFee(g.client, 'base-sepolia');
        expect(f.state).toBe('unavailable');
        expect(f.platform_fee_usd).toBeNull();
        expect(f.note).toMatch(/^Not available: /);
      } finally { await g.close(); }
    }
  });

  it('never throws when the gateway cannot be reached at all', async () => {
    const client = new CertenClient({ apiKey: 'ck_live_test', baseUrl: 'http://127.0.0.1:1', maxRetries: 0, timeoutMs: 500 } as never);
    const f = await estimateFee(client, 'base-sepolia');
    expect(f.state).toBe('unavailable');
  });

  it('a body with no items at all is unavailable, not a crash', async () => {
    const g = await gateway(() => ({ status: 200, body: { price_book_version: 'pb', price_book_hash: 'h', currency: 'USD' } }));
    try {
      expect((await estimateFee(g.client, 'base-sepolia')).state).toBe('unavailable');
    } finally { await g.close(); }
  });
});
