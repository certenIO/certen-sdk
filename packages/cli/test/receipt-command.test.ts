import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { envelope, newHome, certen } from './helpers/run-cli.js';
import { sendEnv, savedReceipts, readSavedReceipt, RECIPIENT, INTENT_ID, ADI, ABSTRACT_ACCOUNT, type SendEnv } from './helpers/send-env.js';

/**
 * `certen receipt`: the record of an intent, shown again, refreshed and re-verified HERE.
 *
 * Driven through the real built CLI against the in-process fake gateway, in a throwaway HOME. The fake serves the repo's own conformance
 * capture, whose pages' chain histories were not captured, so the proof is an honest PARTIAL (the verdict `proof verify` gives these
 * fixtures) and every receipt exits 4. What is pinned is what a wrong receipt would cost:
 *
 *  - a refresh REWRITES the saved file and keeps what the first send knew (when it was made, what was asked, which key signed, the balance
 *    taken before signing), while everything that was uncertain is looked at again;
 *  - `--offline` asks the gateway nothing, and says so by exiting 2 when there is nothing saved to show;
 *  - a saved file this version cannot read is reported and LEFT ALONE, byte for byte: a file written by a newer certen, or by hand, is not
 *    ours to overwrite;
 *  - the caller's own node (`--rpc`) is what closes the proof's execution layer, and its URL (which can carry a key) is never written down.
 */

const OTHER_ID = '99999999-8888-4777-8666-555555555555';
const JUNK_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const sendArgs = (extra: string[] = []): string[] => ['--json', 'send', '0.0001', 'ETH', '--to', RECIPIENT, '--yes', '--wait', ...extra];
const filePath = (home: string, id = INTENT_ID): string => join(home, '.certen', 'receipts', `${id}.json`);
const requests = (env: SendEnv): string[] => env.gateway.take().map((c) => `${c.method} ${c.path}`);

describe('receipt: refresh, show and explain a saved receipt', () => {
  let env: SendEnv;
  let original: string;

  beforeAll(async () => {
    env = await sendEnv();
    const sent = await env.run(sendArgs());
    // The fixture's proof is PARTIAL, so the send ends in exit 4 with a receipt: the same verdict `receipt` must keep reading.
    expect(sent.code).toBe(4);
    original = readFileSync(filePath(env.home), 'utf8');
    env.gateway.take();
    env.gateway.takeNodeCalls();
  });
  afterAll(async () => { await env.close(); });

  const restore = (): void => { writeFileSync(filePath(env.home), original); };

  it('with no argument shows the most recent receipt and says which it is', async () => {
    const r = await env.run(['--json', 'receipt']);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain(`using the most recent receipt, ${INTENT_ID}`);
    const e = envelope(r);
    expect(e.ok).toBe(true);
    expect(e.data!.receipt.intent_id).toBe(INTENT_ID);
    expect(e.data!.refreshed).toBe(true);
    restore();
  });

  it('refreshes from the gateway, rewrites the file, and keeps what the send knew', async () => {
    const before = JSON.parse(original);
    env.gateway.take();
    const r = await env.run(['--json', 'receipt', INTENT_ID]);
    // The exit code follows the verdict: PARTIAL is 4, never 0.
    expect(r.code).toBe(4);
    expect(requests(env)).toContain(`GET /v1/transaction/${INTENT_ID}`);
    const e = envelope(r);
    expect(Object.keys(e.data!).sort()).toEqual(['receipt', 'refreshed', 'saved_to']);
    expect(e.data!.refreshed).toBe(true);
    expect(e.data!.saved_to).toBe(filePath(env.home));
    expect(e.data!.receipt.verdict).toBe('partial');

    const after = readSavedReceipt(env.home);
    expect(after.created_at).toBe(before.created_at);
    expect(after.updated_at > before.updated_at).toBe(true);
    expect(after.request).toEqual(before.request);
    expect(after.signed_with).toEqual(before.signed_with);
    expect(after.request).toMatchObject({ kind: 'transfer', to: RECIPIENT, amount: '0.0001', from: ABSTRACT_ACCOUNT, adi_url: ADI });
    // Written as a receipt, not a transcript: the same document the envelope carried.
    expect(after.intent_id).toBe(e.data!.receipt.intent_id);
    expect(after.receipt_version).toBe(1);
    restore();
  });

  it('writes nothing but the receipt itself: no temporary file is left behind', async () => {
    await env.run(['--json', 'receipt', INTENT_ID]);
    expect(readdirSync(join(env.home, '.certen', 'receipts'))).toEqual([`${INTENT_ID}.json`]);
    restore();
  });

  it('--offline asks the gateway nothing, says it did not refresh, and leaves the file byte for byte as it was', async () => {
    env.gateway.take();
    const r = await env.run(['--json', 'receipt', INTENT_ID, '--offline']);
    expect(r.code).toBe(4);
    expect(requests(env)).toEqual([]);
    const e = envelope(r);
    expect(e.data!.refreshed).toBe(false);
    expect(e.data!.receipt.intent_id).toBe(INTENT_ID);
    expect(readFileSync(filePath(env.home), 'utf8')).toBe(original);
  });

  it('--offline cannot be combined with --rpc or --share: it asks nothing, so it cannot ask a node or make a link', async () => {
    for (const extra of [['--rpc', env.gateway.rpcUrl], ['--share']]) {
      const r = await env.run(['--json', 'receipt', INTENT_ID, '--offline', ...extra]);
      expect(r.code, extra.join(' ')).toBe(2);
      expect(envelope(r).error).toMatchObject({ code: 'CONFLICTING_FLAGS' });
    }
    expect(requests(env)).toEqual([]);
  });

  it('refuses an id that is not an id before any request', async () => {
    env.gateway.take();
    const r = await env.run(['--json', 'receipt', 'not-an-intent-id']);
    expect(r.code).toBe(2);
    expect(envelope(r).error).toMatchObject({ code: 'INVALID_INTENT_ID', retryable: false });
    expect(requests(env)).toEqual([]);
  });

  it('--explain shows the proof layer by layer, names the layer that is not established, and says the node was not consulted', async () => {
    const r = await env.run(['receipt', INTENT_ID, '--explain']);
    expect(r.code).toBe(4);
    // Human mode: the card goes to stdout.
    expect(r.stdout).toContain('The proof, layer by layer');
    for (const id of ['trust_base', 'L4', 'L1', 'L2', 'L3', 'G0', 'G1', 'G1_chains', 'L4_set', 'govRootV3', 'outcome']) expect(r.stdout).toContain(id);
    expect(r.stdout).toMatch(/G1_chains\s+NOT CHECKED/);
    expect(r.stdout).toMatch(/outcome\s+NOT CHECKED/);
    expect(r.stdout).toContain('The execution layer was NOT compared with a node of yours');
    // A layer the document does not carry is said, not hidden.
    expect(r.stdout).toMatch(/G2\s+not carried/);
    expect(r.stdout).toContain('PARTIAL:');
    expect(r.stdout).not.toMatch(/VERIFIED/);
    restore();
  });

  it('--rpc closes the execution layer with a header from the node you gave, and --explain says so', async () => {
    env.gateway.takeNodeCalls();
    const r = await env.run(['receipt', INTENT_ID, '--explain', '--rpc', env.gateway.rpcUrl]);
    expect(r.code).toBe(4);
    expect(r.stdout).toContain('compared with a header from the node you gave');
    expect(r.stdout).toMatch(/outcome\s+verified/);
    expect(r.stdout).not.toContain('NOT compared with a node of yours');
    // G1_chains is still not established: a node of yours cannot supply what the capture never recorded. PARTIAL stays PARTIAL.
    expect(r.stdout).toMatch(/G1_chains\s+NOT CHECKED/);
    restore();
  });

  it('--rpc upgrades a receipt that was made without it, and reads the recipient one block before the transfer', async () => {
    env.gateway.takeNodeCalls();
    const r = await env.run(['--json', 'receipt', INTENT_ID, '--rpc', env.gateway.rpcUrl]);
    expect(r.code).toBe(4);
    const receipt = envelope(r).data!.receipt;
    expect(receipt.proof.node_checked).toBe(true);
    expect(receipt.proof.layers.find((l: { id: string }) => l.id === 'outcome').verdict).toBe('verified');
    expect(receipt.effect.state).toBe('confirmed');
    expect(receipt.effect.recipient).toMatchObject({ source: 'rpc', before: '0', after: '0.0001', delta: '0.0001' });
    // What is left is the capture's, not the node's: only the page chains, and no gap about a node or the recipient.
    expect(receipt.gaps.map((g: { code: string }) => g.code)).toEqual(['PROOF_LAYER_NOT_ESTABLISHED']);
    expect(receipt.verdict).toBe('partial');

    // Without a snapshot from before the signature, the baseline is the balance one block earlier: two reads, at the block before and at the block.
    const calls = env.gateway.takeNodeCalls();
    const balances = calls.filter((c) => c.method === 'eth_getBalance').map((c) => c.params[1]);
    const block = env.gateway.execution.blockNumber;
    expect(balances).toEqual([`0x${(block - 1).toString(16)}`, `0x${block.toString(16)}`]);
    expect(calls.some((c) => c.method === 'eth_chainId')).toBe(true);
    // The node's URL (which can carry a key) is not in the file.
    expect(readFileSync(filePath(env.home), 'utf8')).not.toContain(env.gateway.rpcUrl);
    restore();
  });

  it('--rpc to a node that is another chain is not trusted: the proof is still checked, and the receipt names why the node was not used', async () => {
    // A node that answers on another chain id cannot be told apart from the right one by its header alone here, so this goes through the effect
    // check, which asks the chain first. Run against the fake's own rpc with the chain forced wrong by a second gateway.
    const wrong = await sendEnv({ gateway: { fault: 'rpc-wrong-chain' } });
    try {
      const sent = await wrong.run(sendArgs());
      expect(sent.code).toBe(4);
      const r = await wrong.run(['--json', 'receipt', INTENT_ID, '--rpc', wrong.gateway.rpcUrl]);
      expect(r.code).toBe(4);
      const receipt = envelope(r).data!.receipt;
      expect(receipt.effect.state).toBe('unreadable');
      expect(receipt.effect.detail).toMatch(/is chain 1, not base-sepolia \(84532\)/);
      expect(receipt.effect.detail).not.toContain(wrong.gateway.rpcUrl);
    } finally {
      await wrong.close();
    }
  });

  it('--list lists the receipts on this machine newest first, and skips what is not a receipt', async () => {
    const second = { ...JSON.parse(original), intent_id: OTHER_ID, updated_at: '2020-01-01T00:00:00.000Z' };
    const dir = join(env.home, '.certen', 'receipts');
    writeFileSync(join(dir, `${OTHER_ID}.json`), JSON.stringify(second));
    writeFileSync(join(dir, 'notes.txt'), 'not a receipt');
    writeFileSync(join(dir, 'bad.json'), '{}');
    writeFileSync(join(dir, `${JUNK_ID}.json`), 'not json at all');
    try {
      env.gateway.take();
      const r = await env.run(['--json', 'receipt', '--list']);
      expect(r.code).toBe(0);
      expect(requests(env)).toEqual([]);
      const rows = envelope(r).data!.receipts as Array<{ intent_id: string; verdict: string; headline: string; path: string }>;
      expect(rows.map((x) => x.intent_id)).toEqual([INTENT_ID, OTHER_ID]);
      expect(rows[0]).toMatchObject({ verdict: 'partial', path: filePath(env.home) });

      const human = await env.run(['receipt', '--list']);
      expect(human.code).toBe(0);
      expect(human.stdout.indexOf(INTENT_ID)).toBeGreaterThanOrEqual(0);
      expect(human.stdout.indexOf(INTENT_ID)).toBeLessThan(human.stdout.indexOf(OTHER_ID));
      expect(human.stdout).not.toContain(JUNK_ID);
    } finally {
      for (const f of [`${OTHER_ID}.json`, 'notes.txt', 'bad.json', `${JUNK_ID}.json`]) unlinkSync(join(dir, f));
    }
    expect(savedReceipts(env.home)).toEqual([`${INTENT_ID}.json`]);
  });

  describe('a saved file this version cannot use is reported and left alone', () => {
    const put = (content: string): void => { writeFileSync(filePath(env.home), content); };
    afterAll(() => { writeFileSync(filePath(env.home), original); });

    it('junk: reported, a fresh receipt is built from the gateway, and the file is byte for byte what it was', async () => {
      const junk = 'not json {{';
      put(junk);
      const r = await env.run(['--json', 'receipt', INTENT_ID]);
      expect(r.code).toBe(4);
      expect(r.stderr).toContain('cannot be used');
      expect(r.stderr).toContain('it is not valid JSON');
      const e = envelope(r);
      expect(e.data!.saved_to).toBeNull();
      expect(e.data!.receipt.intent_id).toBe(INTENT_ID);
      // Built from the gateway alone: it does not know what was asked, and says so rather than inventing a request.
      expect(e.data!.receipt.request).toBeNull();
      expect(readFileSync(filePath(env.home), 'utf8')).toBe(junk);
    });

    it('a receipt written by a newer certen says to upgrade and is not overwritten', async () => {
      const newer = JSON.stringify({ ...JSON.parse(original), receipt_version: 99 }, null, 2);
      put(newer);
      const r = await env.run(['--json', 'receipt', INTENT_ID]);
      expect(r.code).toBe(4);
      expect(r.stderr).toContain('receipt version 99');
      expect(r.stderr).toContain('upgrade @certen.io/cli');
      expect(envelope(r).data!.saved_to).toBeNull();
      expect(readFileSync(filePath(env.home), 'utf8')).toBe(newer);
    });

    it('a receipt for another intent saved under this id is unusable, and says so', async () => {
      const wrongIntent = JSON.stringify({ ...JSON.parse(original), intent_id: OTHER_ID }, null, 2);
      put(wrongIntent);
      const r = await env.run(['--json', 'receipt', INTENT_ID]);
      expect(r.code).toBe(4);
      expect(r.stderr).toContain(`it describes intent ${OTHER_ID}, not ${INTENT_ID}`);
      expect(readFileSync(filePath(env.home), 'utf8')).toBe(wrongIntent);
    });

    it('--offline with an unusable file is NO_SAVED_RECEIPT (exit 2), and asks nothing', async () => {
      put('nope');
      env.gateway.take();
      const r = await env.run(['--json', 'receipt', INTENT_ID, '--offline']);
      expect(r.code).toBe(2);
      expect(envelope(r).error).toMatchObject({ code: 'NO_SAVED_RECEIPT' });
      expect(r.stderr).toContain('cannot be used');
      expect(requests(env)).toEqual([]);
      expect(readFileSync(filePath(env.home), 'utf8')).toBe('nope');
    });
  });

  it('--share makes a link for the proof, prints it, and carries it in the envelope', async () => {
    restore();
    env.gateway.take();
    const human = await env.run(['receipt', INTENT_ID, '--share']);
    expect(human.code).toBe(4);
    expect(human.stdout).toMatch(/Share link: http:\/\/127\.0\.0\.1:\d+\/shared\/cps_test_not_a_real_token/);
    expect(human.stdout).toContain('Anyone with this link can read the proof');
    expect(requests(env)).toContain('POST /v1/proof/11111111-2222-4333-8444-555555555555/share');

    const json = await env.run(['--json', 'receipt', INTENT_ID, '--share']);
    expect(json.code).toBe(4);
    const e = envelope(json);
    expect(e.data!.share.url).toMatch(/\/shared\/cps_test_not_a_real_token$/);
    expect(e.data!.share.expires_at).toBe('2026-10-23T00:00:00Z');
    // The link is a thing a person hands over; it is shown, never written into the receipt.
    expect(readFileSync(filePath(env.home), 'utf8')).not.toContain('cps_test_not_a_real_token');
  });
});

describe('receipt: when nothing is saved', () => {
  let env: SendEnv;
  beforeAll(async () => { env = await sendEnv(); });
  afterAll(async () => { await env.close(); });

  it('with no argument and nothing saved says so (NO_RECEIPTS, exit 2) before any request', async () => {
    const r = await env.run(['--json', 'receipt']);
    expect(r.code).toBe(2);
    expect(envelope(r).error).toMatchObject({ code: 'NO_RECEIPTS', retryable: false });
    expect(requests(env)).toEqual([]);
  });

  it('--list with none prints the "No receipts" line and carries an empty list', async () => {
    const json = await env.run(['--json', 'receipt', '--list']);
    expect(json.code).toBe(0);
    expect(envelope(json).data).toEqual({ receipts: [] });
    expect(json.stderr).toContain('No receipts are saved on this machine yet');
    const human = await env.run(['receipt', '--list']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('No receipts are saved on this machine yet');
    expect(requests(env)).toEqual([]);
  });

  it('--offline for an intent with nothing saved is NO_SAVED_RECEIPT (exit 2) and asks nothing', async () => {
    const r = await env.run(['--json', 'receipt', INTENT_ID, '--offline']);
    expect(r.code).toBe(2);
    expect(envelope(r).error).toMatchObject({ code: 'NO_SAVED_RECEIPT' });
    expect(requests(env)).toEqual([]);
    expect(existsSync(join(env.home, '.certen', 'receipts'))).toBe(false);
  });

  it('an intent the gateway has never heard of is the gateway\'s own 404 (exit 1), and nothing is saved', async () => {
    const r = await env.run(['--json', 'receipt', OTHER_ID]);
    expect(r.code).toBe(1);
    expect(envelope(r).error).toMatchObject({ status: 404 });
    expect(existsSync(join(env.home, '.certen', 'receipts'))).toBe(false);
  });

  it('works for an intent opened elsewhere: built from the gateway alone, saved, and honest that it does not know what was asked', async () => {
    // Another machine opened the intent; this one only has its id. Open it through the same gateway, then ask for the receipt from a HOME that
    // never sent anything.
    const opener = await env.run(sendArgs(['--no-wait']));
    expect(opener.code === 0 || opener.code === 4).toBe(true);
    const stranger = newHome();
    const r = await certen(['--json', 'receipt', INTENT_ID], { home: stranger, apiUrl: env.gateway.url, env: { CERTEN_API_KEY: 'ck_live_send_test_not_a_real_key' } });
    expect(r.code).toBe(4);
    const receipt = envelope(r).data!.receipt;
    expect(receipt.request).toBeNull();
    expect(receipt.kind).toBe('unknown');
    expect(receipt.signed_with).toBeNull();
    expect(receipt.effect).toMatchObject({ kind: 'none', state: 'not_applicable' });
    expect(receipt.ids.destination_tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(existsSync(filePath(stranger))).toBe(true);
  });
});

describe('receipt: the balance taken before signing is kept, and used', () => {
  let env: SendEnv;
  beforeAll(async () => { env = await sendEnv(); });
  afterAll(async () => { await env.close(); });

  it('a send with --rpc records the recipient\'s balance before the signature, and a later --rpc refresh measures from it', async () => {
    const sent = await env.run(sendArgs(['--rpc', env.gateway.rpcUrl]));
    expect(sent.code).toBe(4);
    const saved = readSavedReceipt(env.home);
    expect(saved.recipient_snapshot).toMatchObject({ address: RECIPIENT, wei: '0', chain_id: 84532, host: new URL(env.gateway.rpcUrl).host });
    expect(saved.effect.state).toBe('confirmed');
    // The node's URL can carry a key. Only its host is ever written down.
    expect(JSON.stringify(saved)).not.toContain(env.gateway.rpcUrl);

    env.gateway.takeNodeCalls();
    const r = await env.run(['--json', 'receipt', INTENT_ID, '--rpc', env.gateway.rpcUrl]);
    expect(r.code).toBe(4);
    const receipt = envelope(r).data!.receipt;
    expect(receipt.recipient_snapshot).toEqual(saved.recipient_snapshot);
    expect(receipt.effect.state).toBe('confirmed');
    expect(receipt.effect.recipient).toMatchObject({ before: '0', after: '0.0001', delta: '0.0001' });
    // One balance read: at the execution block. The baseline came from the snapshot, not from a second read one block earlier.
    const reads = env.gateway.takeNodeCalls().filter((c) => c.method === 'eth_getBalance');
    expect(reads).toHaveLength(1);
    expect(reads[0]!.params[1]).toBe(`0x${env.gateway.execution.blockNumber.toString(16)}`);
  });

  it('a refresh without --rpc is SHOWN as it can be established now, and does not replace the receipt that was checked against your node', async () => {
    const before = readSavedReceipt(env.home);
    expect(before.effect.state).toBe('confirmed');
    const r = await env.run(['--json', 'receipt', INTENT_ID]);
    expect(r.code).toBe(4);
    const e = envelope(r);
    // This read has no node: the recipient is looked at no more, unchecked, never confirmed on the strength of an earlier look...
    expect(e.data!.receipt.effect.state).toBe('unchecked');
    expect(e.data!.receipt.proof.node_checked).toBe(false);
    // ...and the saved receipt, which was checked against one, is left exactly as it was (with its snapshot and its request).
    expect(e.data!.saved_receipt_kept).toBe('it was compared with a node of yours and this read was not');
    expect(readSavedReceipt(env.home)).toEqual(before);
  });
});

describe('receipt: a contract call, checked against the event it was meant to emit', () => {
  const LEDGER = '0x41bc4283624ff703a6e15b1c2aafae95a5eb335e';
  const CLAIM_PAID = '0x81eb79acc6a0ef94dfb507ea35363f86d0d190b46f4d608dc4c1d7480a7c7cbc';
  let env: SendEnv;
  beforeAll(async () => {
    env = await sendEnv();
    // Human mode, as a person runs it: `call --wait` ends with the receipt, which is saved.
    const called = await env.run(['call', '--to', LEDGER, '--fn', 'confirm(bytes32)', '--arg', `0x${'00'.repeat(32)}`, '--yes', '--wait']);
    expect(called.code).toBe(0);
    expect(savedReceipts(env.home)).toEqual([`${INTENT_ID}.json`]);
  });
  afterAll(async () => { await env.close(); });

  it('call --wait saved a receipt of kind contract_call, with nothing to compare a balance with', () => {
    const saved = readSavedReceipt(env.home);
    expect(saved.kind).toBe('contract_call');
    expect(saved.request.contract_call).toMatchObject({ target: LEDGER, function_signature: 'confirm(bytes32)', value_wei: '0' });
    expect(saved.effect).toMatchObject({ kind: 'none', state: 'not_applicable' });
  });

  it('--expect with the event the proof carries confirms it, and the execution layer is verified against your node', async () => {
    const r = await env.run(['--json', 'receipt', INTENT_ID, '--rpc', env.gateway.rpcUrl, '--expect', `${LEDGER}:${CLAIM_PAID}`]);
    expect(r.code).toBe(4);
    const receipt = envelope(r).data!.receipt;
    expect(receipt.effect).toMatchObject({ kind: 'contract_call', state: 'confirmed', expected_event: { found: true } });
    expect(receipt.proof.layers.find((l: { id: string }) => l.id === 'outcome').verdict).toBe('verified');
    expect(receipt.verdict).toBe('partial');
  });

  it('--expect with an event the proof does not carry FAILS the receipt (exit 1): a valid proof of the wrong call is still the wrong call', async () => {
    const r = await env.run(['--json', 'receipt', INTENT_ID, '--rpc', env.gateway.rpcUrl, '--expect', `${LEDGER}:0x${'ab'.repeat(32)}`]);
    expect(r.code).toBe(1);
    const receipt = envelope(r).data!.receipt;
    expect(receipt.effect).toMatchObject({ kind: 'contract_call', state: 'not_observed', expected_event: { found: false } });
    expect(receipt.proof.verdict).toBe('failed');
    expect(receipt.verdict).toBe('failed');
    expect(receipt.headline).toMatch(/^FAILED:/);
  });
});

describe('receipt --share when there is nothing to share', () => {
  let env: SendEnv;
  beforeAll(async () => { env = await sendEnv({ gateway: { statuses: ['anchoring'] } }); });
  afterAll(async () => { await env.close(); });

  it('an intent that has no proof yet is NOTHING_TO_SHARE (exit 1), and no link is asked for', async () => {
    const sent = await env.run(sendArgs(['--no-wait']));
    // --no-wait returns once the signature is in: a success of the command, with a receipt that says it is pending.
    expect(sent.code).toBe(0);
    expect(envelope(sent).data!.receipt.verdict).toBe('pending');
    env.gateway.take();
    const r = await env.run(['--json', 'receipt', INTENT_ID, '--share']);
    expect(r.code).toBe(1);
    expect(envelope(r).error).toMatchObject({ code: 'NOTHING_TO_SHARE' });
    expect(requests(env).filter((p) => p.startsWith('POST') && p.endsWith('/share'))).toEqual([]);
  });

  it('a receipt for an intent that has not finished exits 4 and points at watch', async () => {
    const r = await env.run(['receipt', INTENT_ID]);
    expect(r.code).toBe(4);
    expect(r.stdout).toContain(`Next: certen watch ${INTENT_ID}`);
    expect(r.stdout).toMatch(/PENDING|pending/);
    expect(r.stdout).not.toMatch(/VERIFIED/);
  });
});
