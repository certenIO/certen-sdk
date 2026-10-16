import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assembleReceipt, type Receipt, type TransactionResponse } from '@certen.io/sdk';

/**
 * `~/.certen/receipts`: the record of an intent, kept.
 *
 * What is pinned is what a wrong store would cost: a half-written receipt after a crash, a receipt written outside the directory because of
 * what an intent id looked like, a corrupt or newer file silently replaced, and the developer's real home touched by a test.
 */

let scratch = '';
vi.mock('os', async (orig) => ({ ...(await orig<typeof import('os')>()), homedir: () => scratch }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => scratch }));

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'certen-receipts-'));
  vi.resetModules();
});
afterEach(() => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* noop */ } });

const store = () => import('../src/receipt-store.js');

const ID_A = '7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b13';
const ID_B = '8d2f4c1b-6e30-4d7f-8b2c-1f9a3e5b7c24';

function receipt(intentId: string, updatedAt = '2026-10-15T12:00:00.000Z', status = 'anchoring'): Receipt {
  return assembleReceipt({
    intentId,
    transaction: { intent_id: intentId, identity_id: 'i', status, created_at: '2026-10-15T00:00:00Z' } as TransactionResponse,
    now: () => new Date(updatedAt),
  });
}

describe('saveReceipt / loadReceipt', () => {
  it('writes where it says it did, under the home it was given, and reads back exactly what was written', async () => {
    const m = await store();
    const r = receipt(ID_A);
    const path = m.saveReceipt(r);
    expect(path).toBe(join(scratch, '.certen', 'receipts', `${ID_A}.json`));
    expect(m.receiptsDir()).toBe(join(scratch, '.certen', 'receipts'));
    const loaded = m.loadReceipt(ID_A);
    expect(loaded).toEqual({ state: 'ok', receipt: r, path });
  });

  it('replaces an earlier receipt for the same intent, atomically: no temporary file is left beside it', async () => {
    const m = await store();
    m.saveReceipt(receipt(ID_A, '2026-10-15T12:00:00.000Z', 'anchoring'));
    m.saveReceipt(receipt(ID_A, '2026-10-15T12:05:00.000Z', 'executed'));
    expect(readdirSync(m.receiptsDir())).toEqual([`${ID_A}.json`]);
    const loaded = m.loadReceipt(ID_A);
    expect(loaded.state === 'ok' && loaded.receipt.status.gateway_status).toBe('executed');
  });

  it('owner-only on a system that has modes (Windows has none, and says nothing about them)', async () => {
    const m = await store();
    const path = m.saveReceipt(receipt(ID_A));
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o077).toBe(0);
      expect(statSync(m.receiptsDir()).mode & 0o077).toBe(0);
    } else {
      expect(existsSync(path)).toBe(true);
    }
  });

  it('holds no secret: ids, addresses, hashes and verdicts only', async () => {
    const m = await store();
    const path = m.saveReceipt(receipt(ID_A));
    const text = readFileSync(path, 'utf8');
    expect(text).not.toMatch(/api[_-]?key|passphrase|private|secret|ck_live/i);
  });

  it('is absent when nothing was saved', async () => {
    const m = await store();
    expect(m.loadReceipt(ID_A)).toEqual({ state: 'absent' });
  });
});

describe('an intent id becomes a file name only if it plainly is one', () => {
  it.each(['../evil', '..\\evil', 'a/b', '', 'a b', '7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b13/../x', 'short', 'x'.repeat(200), '7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b1\u0000'])(
    'refuses %j before touching the disk',
    async (bad) => {
      const m = await store();
      expect(() => m.receiptPath(bad)).toThrowError(expect.objectContaining({ code: 'INVALID_INTENT_ID', exitCode: 2 }));
      expect(() => m.loadReceipt(bad)).toThrowError(expect.objectContaining({ code: 'INVALID_INTENT_ID' }));
      expect(existsSync(join(scratch, '.certen'))).toBe(false);
    },
  );

  it('accepts the ids the gateway uses', async () => {
    const m = await store();
    expect(() => m.receiptPath(ID_A)).not.toThrow();
    expect(() => m.receiptPath('intent-1-abc')).not.toThrow();
  });
});

describe('a file that cannot be used is reported, never half-used, and left as it is', () => {
  async function plant(contents: string): Promise<{ m: Awaited<ReturnType<typeof store>>; path: string }> {
    const m = await store();
    mkdirSync(m.receiptsDir(), { recursive: true });
    const path = m.receiptPath(ID_A);
    writeFileSync(path, contents);
    return { m, path };
  }

  it('not JSON', async () => {
    const { m, path } = await plant('{ this is not json');
    const loaded = m.loadReceipt(ID_A);
    expect(loaded).toMatchObject({ state: 'unusable', path });
    expect(loaded.state === 'unusable' && loaded.reason).toMatch(/not valid JSON/);
    expect(readFileSync(path, 'utf8')).toBe('{ this is not json');
  });

  it('JSON that is not a receipt', async () => {
    const { m } = await plant('[1, 2, 3]');
    expect(m.loadReceipt(ID_A)).toMatchObject({ state: 'unusable' });
    const { m: m2 } = await plant('"just a string"');
    expect(m2.loadReceipt(ID_A)).toMatchObject({ state: 'unusable', reason: 'it is not a receipt' });
  });

  it('written by a newer certen: it says which version this one reads, and to upgrade', async () => {
    const { m } = await plant(JSON.stringify({ ...receipt(ID_A), receipt_version: 99 }));
    const loaded = m.loadReceipt(ID_A);
    expect(loaded.state).toBe('unusable');
    expect(loaded.state === 'unusable' && loaded.reason).toMatch(/receipt version 99, and this certen reads up to 1: upgrade @certen\.io\/cli/);
  });

  it('no version at all', async () => {
    const { m } = await plant(JSON.stringify({ intent_id: ID_A }));
    expect(m.loadReceipt(ID_A)).toMatchObject({ state: 'unusable', reason: expect.stringMatching(/receipt version undefined/) });
  });

  it('a receipt for another intent saved under this id', async () => {
    const { m } = await plant(JSON.stringify(receipt(ID_B)));
    const loaded = m.loadReceipt(ID_A);
    expect(loaded.state === 'unusable' && loaded.reason).toBe(`it describes intent ${ID_B}, not ${ID_A}`);
  });
});

describe('a save that cannot happen says so and does not lose the id', () => {
  it('RECEIPT_NOT_SAVED names the intent id to keep, and the transaction is unaffected', async () => {
    const m = await store();
    // A FILE where the directory should be: the write cannot succeed.
    mkdirSync(join(scratch, '.certen'), { recursive: true });
    writeFileSync(join(scratch, '.certen', 'receipts'), 'in the way');
    expect(() => m.saveReceipt(receipt(ID_A))).toThrowError(expect.objectContaining({
      code: 'RECEIPT_NOT_SAVED',
      message: expect.stringContaining(`keep the intent id ${ID_A}`),
    }));
  });
});

describe('listReceipts', () => {
  it('lists newest first, skipping anything that is not a usable receipt', async () => {
    const m = await store();
    m.saveReceipt(receipt(ID_A, '2026-10-15T10:00:00.000Z'));
    m.saveReceipt(receipt(ID_B, '2026-10-15T11:00:00.000Z', 'failed'));
    writeFileSync(join(m.receiptsDir(), 'notes.txt'), 'not a receipt');
    writeFileSync(join(m.receiptsDir(), 'not-an-id!.json'), '{}');
    writeFileSync(join(m.receiptsDir(), `${'9'.repeat(8)}-corrupt-id1.json`), 'garbage');
    const list = m.listReceipts();
    expect(list.map((r) => r.intent_id)).toEqual([ID_B, ID_A]);
    expect(list[0]).toMatchObject({ verdict: 'failed', kind: 'unknown', path: join(m.receiptsDir(), `${ID_B}.json`) });
    expect(list[0]!.headline).toMatch(/^FAILED: /);
  });

  it('is empty when there is no directory yet, and does not create one', async () => {
    const m = await store();
    expect(m.listReceipts()).toEqual([]);
    expect(existsSync(m.receiptsDir())).toBe(false);
  });
});
