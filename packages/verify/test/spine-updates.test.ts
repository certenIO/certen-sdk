import { createPrivateKey, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { core } from 'accumulate-sdk-opendlt';
import { encodeObject, messageHash, networkDefinition, networkGlobals, sequencedMessage, transaction, transactionHash } from '../src/proof-v2/accumulate.js';
import { sha256, toHex, VerifyError } from '../src/proof-v2/bytes.js';
import { genesisGlobals, Spine } from '../src/proof-v2/spine.js';

/**
 * The Directory spine applies a proven write to acc://dn.acme/network or acc://dn.acme/globals, as Go's applyProvenUpdate
 * does (before this, the TypeScript verifier refused such a spine). The validators here hold keys made for the test, so
 * every anchor is really signed and really verified; what the cases pin is the rule, not a recorded proof.
 */
const DN = 'acc://dn.acme';
const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

interface Val { pub: string; priv: Uint8Array; hash: string }
function val(): Val {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  return { pub: Buffer.from(raw).toString('hex'), priv: new Uint8Array(seed), hash: toHex(sha256(raw)) };
}

const defJson = (version: number, vs: Val[], activeOn = ['Directory']) => ({
  networkName: 'TestNet',
  version,
  partitions: [{ id: 'Directory', type: 'directory' }],
  validators: vs.map((v) => ({ publicKey: v.pub, publicKeyHash: v.hash, partitions: activeOn.map((id) => ({ id, active: true })) })),
});
const globJson = (num: number, den: number) => ({ operatorAcceptThreshold: { numerator: 2, denominator: 3 }, validatorAcceptThreshold: { numerator: num, denominator: den }, majorBlockSchedule: '0 */12 * * *' });
const record = (o: unknown) => encodeObject(o);

function genesis(vs: Val[], num = 2, den = 3) {
  const net = networkDefinition(defJson(1, vs));
  const glob = networkGlobals(globJson(num, den));
  return genesisGlobals(net.asObject(), record(net), glob.asObject(), record(glob));
}

/** The signature a Directory validator would put on the anchor message. */
function signAnchor(v: Val, msgJson: unknown, type = 'ed25519', over?: Partial<Record<string, unknown>>) {
  const msgHash = messageHash(sequencedMessage(msgJson, 'anchor'));
  const meta: Record<string, unknown> = { type, publicKey: v.pub, signer: `${DN}/network`, signerVersion: 1, timestamp: 1700000000000, ...over };
  const mdHash = sha256(encodeObject((core as any).Signature.fromObject(meta)));
  const key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, Buffer.from(v.priv)]), format: 'der', type: 'pkcs8' });
  const sig = nodeSign(null, sha256(mdHash, msgHash), key);
  return { ...meta, signature: sig.toString('hex'), transactionHash: toHex(msgHash) };
}

function writeData(principal: string, data: Uint8Array[]) {
  return { header: { principal }, body: { type: 'writeData', entry: { type: 'accumulate', data: data.map((d) => Buffer.from(d).toString('hex')) } } };
}
/** An update proven into a root chain whose only entry is the transaction itself: the receipt has no steps. */
function update(tx: any) {
  const h = toHex(transactionHash(transaction(tx, 'tx')));
  return { transaction: tx, receipt: { start: h, end: h, anchor: h, entries: [] }, h };
}

let counter = 0;
function major(index: number, minor: number, root: string) {
  const msg = {
    type: 'sequenced',
    message: { type: 'transaction', transaction: { header: { principal: `${DN}/anchors` }, body: { type: 'directoryAnchor', source: DN, minorBlockIndex: minor, rootChainIndex: minor, rootChainAnchor: root, stateTreeAnchor: toHex(sha256(new Uint8Array([++counter]))), makeMajorBlockTime: '0001-01-01T00:00:00Z' } } },
    source: DN,
    destination: DN,
    number: minor,
  };
  return { index, entry: { source: 1, blockIndex: index, blockTime: '2026-01-01T00:00:00Z', rootIndexIndex: 1 }, anchor: msg };
}
function record_(index: number, minor: number, signers: Val[], updates: ReturnType<typeof update>[] = [], root?: string, type = 'ed25519') {
  const r = major(index, minor, root ?? (updates[0]?.h ?? toHex(sha256(new Uint8Array([index])))));
  return { ...r, signatures: signers.map((s) => signAnchor(s, r.anchor, type)), updates: updates.map(({ transaction, receipt }) => ({ transaction, receipt })) };
}
const names = (s: Spine) => s.validators().map((v) => v.publicKey);

describe('the spine applies a proven network update', () => {
  const [a, b, c, d] = [val(), val(), val(), val()];

  it('walks without an update (the control)', () => {
    const sp = new Spine(genesis([a, b, c]), 1);
    sp.advance(record_(1, 10, [a, b]), 'm1');
    expect(sp.lastMinorBlock).toBe(10);
    expect(sp.applied).toEqual([]);
    expect(sp.directoryThreshold()).toBe(2);
  });

  it('adopts a higher-version definition, counts it, and holds the next anchor to the new set', () => {
    const sp = new Spine(genesis([a, b, c]), 1);
    const def2 = networkDefinition(defJson(2, [b, c, d]));
    const u = update(writeData(`${DN}/network`, [record(def2)]));
    // signed by the set before the update (the update's own block): accepted by the fallback to the pre-update set
    sp.advance(record_(1, 10, [a, b], [u]), 'm1');
    expect(sp.applied).toHaveLength(1);
    expect(sp.applied[0]).toMatchObject({ principal: `${DN}/network`, anchorMinorBlock: 10 });
    expect(names(sp)).toEqual([b.pub, c.pub, d.pub]);
    expect(toHex(sp.g.networkRecord)).toBe(toHex(record(def2)));
    // the removed validator can no longer carry an anchor
    expect(() => sp.clone().advance(record_(2, 11, [a, b]), 'm2')).toThrow(/not an active directory validator/);
    // the new set can
    sp.advance(record_(2, 11, [c, d]), 'm2');
    expect(sp.lastMinorBlock).toBe(11);
  });

  it('accepts an anchor signed by the post-update set when the update is in the window before it', () => {
    const sp = new Spine(genesis([a, b, c]), 1);
    const def2 = networkDefinition(defJson(2, [b, c, d]));
    sp.advance(record_(1, 10, [b, c, d], [update(writeData(`${DN}/network`, [record(def2)]))]), 'm1');
    expect(names(sp)).toEqual([b.pub, c.pub, d.pub]);
  });

  it('records a stale definition as accounted for without changing the set', () => {
    const sp = new Spine(genesis([a, b, c]), 1);
    const stale = networkDefinition(defJson(1, [d]));
    sp.advance(record_(1, 10, [a, b], [update(writeData(`${DN}/network`, [record(stale)]))]), 'm1');
    expect(sp.applied).toHaveLength(1);
    expect(names(sp)).toEqual([a.pub, b.pub, c.pub]);
  });

  it('adopts new globals: the quorum threshold follows the accept threshold', () => {
    const sp = new Spine(genesis([a, b, c], 2, 3), 1);
    const g2 = networkGlobals(globJson(3, 3));
    sp.advance(record_(1, 10, [a, b], [update(writeData(`${DN}/globals`, [record(g2)]))]), 'm1');
    expect(sp.applied[0].principal).toBe(`${DN}/globals`);
    expect(sp.directoryThreshold()).toBe(3);
    expect(() => sp.clone().advance(record_(2, 11, [a, b]), 'm2')).toThrow(/quorum not met: 2 of 3/);
    sp.advance(record_(2, 11, [a, b, c]), 'm2');
  });

  it('ignores a write to any other account and any other transaction type', () => {
    const sp = new Spine(genesis([a, b, c]), 1);
    const other = update(writeData('acc://something.acme/data', [record(networkDefinition(defJson(9, [d])))]));
    const nonWrite = update({ header: { principal: `${DN}/network` }, body: { type: 'systemGenesis' } });
    sp.advance(record_(1, 10, [a, b], [other]), 'm1');
    sp.advance(record_(2, 11, [a, b], [nonWrite]), 'm2');
    expect(sp.applied).toEqual([]);
    expect(names(sp)).toEqual([a.pub, b.pub, c.pub]);
  });

  it('applies several updates in order within one anchor', () => {
    const sp = new Spine(genesis([a, b, c]), 1);
    const u1 = update(writeData(`${DN}/network`, [record(networkDefinition(defJson(2, [a, b, c, d])))]));
    const u2 = update(writeData(`${DN}/network`, [record(networkDefinition(defJson(3, [c, d])))]));
    // both receipts must end at the anchor's root: a chain of one entry cannot hold two, so give the second its own anchor root
    // by chaining u2's receipt through u1: (u1, u2) -> sha256(u1 || u2)
    const root = toHex(sha256(Buffer.from(u1.h, 'hex'), Buffer.from(u2.h, 'hex')));
    const upd = [
      { transaction: u1.transaction, receipt: { start: u1.h, end: u1.h, anchor: root, entries: [{ hash: u2.h, right: true }] } },
      { transaction: u2.transaction, receipt: { start: u2.h, end: u2.h, anchor: root, entries: [{ hash: u1.h }] } },
    ];
    const r = major(1, 10, root);
    sp.advance({ ...r, signatures: [a, b].map((s) => signAnchor(s, r.anchor)), updates: upd }, 'm1');
    expect(sp.applied).toHaveLength(2);
    expect(names(sp)).toEqual([c.pub, d.pub]);
  });

  describe('refuses, by name', () => {
    const run = (mutate: (u: any, r: any) => void, vs = [a, b, c]) => {
      const sp = new Spine(genesis(vs), 1);
      const u = update(writeData(`${DN}/network`, [record(networkDefinition(defJson(2, [b, c, d])))]));
      const rec: any = record_(1, 10, [a, b], [u]);
      mutate(rec.updates[0], rec);
      return () => sp.advance(rec, 'm1');
    };

    it('an update whose receipt does not end at the anchor\'s root', () => {
      expect(run((u) => { u.receipt.anchor = '00'.repeat(32); })).toThrow(/does not end at the anchor's root/);
    });
    it('an update whose receipt does not start at its transaction', () => {
      expect(run((u) => { u.receipt.start = '11'.repeat(32); })).toThrow(/does not start at the transaction/);
    });
    it('a written definition changed after it was proven (the receipt no longer binds it)', () => {
      expect(run((u) => { const d0 = u.transaction.body.entry.data[0]; u.transaction.body.entry.data[0] = d0.slice(0, -2) + (d0.endsWith('00') ? '01' : '00'); })).toThrow(/does not start at the transaction/);
    });
    it('an entry that holds two records', () => {
      const sp = new Spine(genesis([a, b, c]), 1);
      const two = update(writeData(`${DN}/network`, [record(networkDefinition(defJson(2, [d]))), new Uint8Array([0x80])]));
      expect(() => sp.advance(record_(1, 10, [a, b], [two]), 'm1')).toThrow(/want 1 record, got 2/);
    });
    it('an entry that is not a record the SDK would write', () => {
      const sp = new Spine(genesis([a, b, c]), 1);
      const junk = update(writeData(`${DN}/network`, [new Uint8Array([1, 2, 0xc3, 0x28])]));
      expect(() => sp.advance(record_(1, 10, [a, b], [junk]), 'm1')).toThrow(/network_update_undecodable/);
    });
    it('a signature type the spine does not accept', () => {
      const sp = new Spine(genesis([a, b, c]), 1);
      const r: any = record_(1, 10, [a, b]);
      r.signatures[0].type = 'btc';
      expect(() => sp.advance(r, 'm1')).toThrow(/signature_type_unsupported/);
    });
    it('a quorum that is not met after an update that raises the threshold', () => {
      const sp = new Spine(genesis([a, b, c]), 1);
      sp.advance(record_(1, 10, [a, b], [update(writeData(`${DN}/globals`, [record(networkGlobals(globJson(3, 3)))]))]), 'm1');
      expect(() => sp.advance(record_(2, 11, [a, b]), 'm2')).toThrow(/quorum not met/);
    });
  });
});
