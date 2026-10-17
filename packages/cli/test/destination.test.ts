import { describe, it, expect, afterEach } from 'vitest';
import { assembleReceipt, type Receipt, type TransactionResponse } from '@certen.io/sdk';
import { destinationLines, destinationOf, destinationRows, withoutDestination, UNVERIFIED } from '../src/destination.js';
import { receiptLines } from '../src/receipt-render.js';
import { printable } from '../src/gateway-text.js';
import { certen, envelope } from './helpers/run-cli.js';
import { startStub, homeFor, WHO, frontGateway, type Stub } from './helpers/stub-gateway.js';
import { sendEnv, INTENT_ID, RECIPIENT, type SendEnv } from './helpers/send-env.js';

/**
 * The destination transaction: the one hash the CLI shows that NOTHING verified.
 *
 * The gateway copies it from what the validators recorded and does not read the chain. So it is shown wherever a transaction or a receipt is
 * shown, and it is shown with that caveat every time, in the same words, and never in the place the verified facts are. What is pinned:
 *
 * - the label is attached to ANY shape of destination that shows anything (a hash alone, a settlement alone, a chain alone);
 * - a destination that is null, absent or empty renders as nothing in a table, and as `null` in `--json` (the key is always there);
 * - text the gateway wrote cannot move the cursor or repaint a line;
 * - `tx status`, `receipt`, `watch` and `send` all show it, and the machine envelope carries the object.
 */

const HASH = `0x${'ab'.repeat(32)}`;
const DEST = { chain_id: 84532, tx_hash: HASH, settlement: 'settled', source: 'validators' } as const;

describe('destinationOf and destinationLines', () => {
  it('reads the object off a transaction, and nothing off one that has none', () => {
    expect(destinationOf({ destination: DEST })).toEqual(DEST);
    for (const none of [{}, { destination: null }, { destination: undefined }, { destination: {} }, { destination: [] }, { destination: 'x' }, null, undefined]) {
      expect(destinationOf(none), JSON.stringify(none)).toBeNull();
    }
  });

  it('shows the chain, the hash and the settlement, and says in the same breath that it is the validators\' word and unverified', () => {
    const lines = destinationLines(DEST);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`destination base-sepolia   tx ${HASH}   settlement settled`);
    expect(lines[1]).toContain(UNVERIFIED);
    expect(UNVERIFIED).toBe('as recorded by the validators; not verified');
    // It points at the thing that does verify, and does not claim to be it.
    expect(lines[1]).toContain('certen receipt');
  });

  it('carries the label for every shape that shows anything at all', () => {
    for (const d of [{ tx_hash: HASH }, { settlement: 'reverted' }, { chain_id: 84532 }, { chain_id: 999999, tx_hash: HASH }, { settlement: 'none', tx_hash: HASH }]) {
      const lines = destinationLines(destinationOf({ destination: d }));
      expect(lines.join('\n'), JSON.stringify(d)).toContain(UNVERIFIED);
    }
  });

  it('names a chain this client does not know by its number, and a missing hash or settlement plainly', () => {
    expect(destinationLines({ chain_id: 999999, tx_hash: HASH })[0]).toBe(`destination chain 999999   tx ${HASH}   settlement not stated`);
    expect(destinationLines({ settlement: 'unobserved' })[0]).toBe('destination destination chain   no transaction hash recorded   settlement unobserved');
  });

  it('renders nothing for no destination', () => {
    expect(destinationLines(null)).toEqual([]);
    expect(destinationRows(null)).toEqual([]);
  });

  it('cannot be made to repaint the terminal: control characters in what the validators wrote are stripped', () => {
    const ESC = String.fromCharCode(27);
    const lines = destinationLines({ chain_id: 84532, tx_hash: `0xabc${ESC}[2K${ESC}[1;32mCONFIRMED BY CERTEN${ESC}[0m\nsettlement settled`, settlement: `settled${ESC}[31m` });
    // eslint-disable-next-line no-control-regex
    expect(lines.join('\n')).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    // One line per row: a newline in the hash did not start a row of its own.
    expect(lines).toHaveLength(2);
    expect(printable(`a${ESC}b\u009bc`)).toBe('a b c');
  });

  it('withoutDestination drops only that key', () => {
    expect(withoutDestination({ status: 'completed', destination: DEST })).toEqual({ status: 'completed' });
  });
});

describe('the receipt shows it under its own label, apart from what was verified', () => {
  const T0 = new Date('2026-10-15T12:00:00Z');
  const receipt = (): Receipt => assembleReceipt({
    intentId: INTENT_ID,
    transaction: { intent_id: INTENT_ID, identity_id: 'identity-1', status: 'completed', created_at: '2026-10-15T00:00:00Z', accum_tx_hash: `acc://${'ab'.repeat(32)}@x.acme/data` } as TransactionResponse,
    request: null, now: () => T0, registry: null,
  });

  it('adds a Recorded row with the destination and the caveat when the gateway reported one', () => {
    const text = receiptLines(receipt(), { destination: DEST }).join('\n');
    expect(text).toContain(`Recorded  destination base-sepolia   tx ${HASH}   settlement settled`);
    expect(text).toContain(UNVERIFIED);
    // Nothing about it reads as the proof's verdict.
    expect(text.split('\n').filter((l) => l.includes('Recorded') || l.includes(UNVERIFIED)).join('\n')).not.toMatch(/VERIFIED|verified:/);
  });

  it('adds nothing when there is none: no row, no empty label', () => {
    for (const none of [undefined, null]) {
      const text = receiptLines(receipt(), { destination: none }).join('\n');
      expect(text).not.toContain('Recorded');
      expect(text).not.toContain(UNVERIFIED);
    }
    expect(receiptLines(receipt()).join('\n')).toBe(receiptLines(receipt(), { destination: null }).join('\n'));
  });
});

// ── the commands, as subprocesses ───────────────────────────────────────────────────────────────

let stub: Stub | undefined;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await stub?.close(); stub = undefined;
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

const TX_ID = '7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b13';
const transaction = (extra: Record<string, unknown> = {}) => ({
  intent_id: TX_ID, identity_id: WHO.id, status: 'completed', intent_type: 'transfer', created_at: '2026-10-15T00:00:00Z', proof_id: 'proof-1', ...extra,
});

describe('certen tx status', () => {
  const serve = async (extra: Record<string, unknown>): Promise<string> => {
    stub = await startStub((r) => (r.path === `/v1/transaction/${TX_ID}` ? { body: transaction(extra) } : undefined));
    return homeFor(stub.url);
  };

  it('prints the destination in a table with its label, and not as an unlabelled JSON row', async () => {
    const home = await serve({ destination: DEST });
    const r = await certen(['tx', 'status', TX_ID], { home, apiUrl: stub!.url });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Recorded  destination base-sepolia   tx ${HASH}   settlement settled`);
    expect(r.stdout).toContain(UNVERIFIED);
    // The generic table would have printed `destination  {"chain_id":84532,...}` with nothing to say it was unchecked.
    expect(r.stdout).not.toMatch(/^destination\s+\{/m);
    expect(r.stdout).not.toContain('"tx_hash"');
  });

  it('--json carries the object exactly as the gateway sent it', async () => {
    const home = await serve({ destination: DEST });
    const e = envelope(await certen(['--json', 'tx', 'status', TX_ID], { home, apiUrl: stub!.url }));
    expect(e.ok).toBe(true);
    expect(e.data!.destination).toEqual(DEST);
  });

  it('null is a clean absence: no row in a table, null in --json', async () => {
    const home = await serve({ destination: null });
    const human = await certen(['tx', 'status', TX_ID], { home, apiUrl: stub!.url });
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).not.toContain('Recorded');
    expect(human.stdout).not.toContain(UNVERIFIED);
    expect(human.stdout).not.toMatch(/^destination/m);
    expect(envelope(await certen(['--json', 'tx', 'status', TX_ID], { home, apiUrl: stub!.url })).data!.destination).toBeNull();
  });

  it('a gateway that does not send the field at all still gives a script a null to read', async () => {
    const home = await serve({});
    const r = await certen(['--json', 'tx', 'status', TX_ID], { home, apiUrl: stub!.url });
    const data = envelope(r).data!;
    expect('destination' in data).toBe(true);
    expect(data.destination).toBeNull();
  });
});

/** A case that runs several commands in turn (a send, then what reads it back) pays a process start for each; the suite default is sized for one. */
const SEVERAL = 90_000;

describe('certen send, receipt and watch', () => {
  /** The fake gateway, behind a front that adds the `destination` the fake does not model to every read of the intent. */
  async function withDestination(destination: unknown): Promise<{ run: SendEnv['run'] }> {
    const env = await sendEnv();
    const front = await frontGateway(env.gateway.url, async (request, forwarded) => {
      if (request.method === 'GET' && request.path === `/v1/transaction/${INTENT_ID}`) {
        const upstream = await forwarded();
        return { status: upstream.status, body: { ...upstream.body, destination } };
      }
      return undefined;
    });
    cleanups.push(() => front.close(), () => env.close());
    return { run: (args, opts = {}) => env.run(args, { ...opts, env: { ...(opts.env ?? {}), CERTEN_API_URL: front.url } }) };
  }

  it('send shows it with its label in the result, apart from the verified rows', async () => {
    const { run } = await withDestination(DEST);
    const human = await run(['send', '0.0001', 'ETH', '--to', RECIPIENT, '--wait', '--yes']);
    expect([0, 4], human.stderr).toContain(human.code);
    expect(human.stdout).toContain(`Recorded  destination base-sepolia   tx ${HASH}   settlement settled`);
    expect(human.stdout).toContain(UNVERIFIED);
    // The verified part of the receipt is a different row from the unverified record.
    expect(human.stdout).toMatch(/Proof\s+/);

  });

  it('send --json carries the object next to the receipt', async () => {
    const { run } = await withDestination(DEST);
    const json = await run(['--json', 'send', '0.0001', 'ETH', '--to', RECIPIENT, '--wait', '--yes']);
    const data = envelope(json).data!;
    expect(Object.keys(data).sort()).toEqual(['destination', 'receipt', 'saved_to']);
    expect(data.destination).toEqual(DEST);
  });

  it('with no destination recorded, send prints no empty label and --json says null', async () => {
    const { run } = await withDestination(null);
    const human = await run(['send', '0.0001', 'ETH', '--to', RECIPIENT, '--wait', '--yes']);
    expect(human.stdout).not.toContain('Recorded');
    expect(human.stdout).not.toContain(UNVERIFIED);
    const json = envelope(await run(['--json', 'receipt', INTENT_ID, '--refresh']));
    expect(json.data!.destination).toBeNull();
  }, SEVERAL);

  it('receipt (refreshed) and watch show it; receipt --offline asks the gateway nothing and so has none', async () => {
    const { run } = await withDestination(DEST);
    const sent = await run(['--json', 'send', '0.0001', 'ETH', '--to', RECIPIENT, '--wait', '--yes']);
    expect([0, 4], sent.stderr).toContain(sent.code);

    const refreshed = await run(['--json', 'receipt', INTENT_ID]);
    expect(envelope(refreshed).data!.destination).toEqual(DEST);
    const shown = await run(['receipt', INTENT_ID]);
    expect(shown.stdout).toContain(UNVERIFIED);

    const watched = await run(['--json', 'watch', INTENT_ID]);
    expect(envelope(watched).data!.destination).toEqual(DEST);
    const watchedHuman = await run(['watch', INTENT_ID]);
    expect(watchedHuman.stdout).toContain(UNVERIFIED);

    const offline = await run(['--json', 'receipt', INTENT_ID, '--offline']);
    const data = envelope(offline).data!;
    expect('destination' in data).toBe(false);
    expect(offline.stdout + offline.stderr).not.toContain(HASH);
  }, SEVERAL);

  it('never prints the API key', async () => {
    const { run } = await withDestination(DEST);
    const r = await run(['send', '0.0001', 'ETH', '--to', RECIPIENT, '--wait', '--yes']);
    expect(r.stdout + r.stderr).not.toContain('ck_live_send_test_not_a_real_key');
  });
});
