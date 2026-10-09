import { readFileSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  reconstructSigning,
  verifySigningData,
  SigningDataAbsent,
  SigningDataMismatch,
  SIGNING_DATA_ABSENT,
  SIGNING_DATA_MISMATCH,
  type Expectation,
} from '../src/index.js';

/**
 * Sign what you see, against transactions CERTEN really put on the Kermit testnet.
 *
 * Each vector is a transaction as the network returns it plus the signature the identity's key put on it. The recipe under test
 * (rebuild the transaction, hash it, hash the signature metadata, sha256(sigMdHash || txHash)) is proved by the network itself:
 * the transaction hash must be the id the network knows it by, the metadata hash must be the header's initiator, and the ed25519
 * signature on chain must verify over the recomputed signing hash. Nothing in the expected values below is computed by the code
 * under test.
 */
const { vectors } = JSON.parse(readFileSync(new URL('./fixtures/signing-vectors.json', import.meta.url), 'utf8')) as {
  vectors: { label: string; kind: string; txid: string; transaction: any; onChainSignature: Record<string, any> }[];
};
const by = (label: string) => vectors.find((v) => v.label === label)!;
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const onChainVerifies = (v: (typeof vectors)[number], hashToSign: string) =>
  verify(null, Buffer.from(hashToSign, 'hex'), createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(v.onChainSignature.publicKey, 'hex')]), format: 'der', type: 'spki' }), Buffer.from(v.onChainSignature.signature, 'hex'));

const metadataOf = (v: (typeof vectors)[number]) => ({
  type: 'ed25519',
  public_key: v.onChainSignature.publicKey,
  signer: v.onChainSignature.signer,
  signer_version: v.onChainSignature.signerVersion,
  timestamp_us: v.onChainSignature.timestamp,
  ...(v.onChainSignature.vote ? { vote: v.onChainSignature.vote } : {}),
});
const gatewaySigningData = (v: (typeof vectors)[number]) => {
  const r = reconstructSigning(v.transaction, metadataOf(v));
  return { transaction_hash: r.transactionHash, hash_to_sign: r.hashToSign, transaction: v.transaction, signature_metadata: metadataOf(v) };
};

describe('the recipe, proved by the network', () => {
  it('has the vectors', () => {
    expect(vectors.map((v) => v.label)).toEqual([
      'single-leg-native-transfer', 'single-leg-contract-call-with-events', 'two-leg', 'four-leg',
      'governance-key-rotation-rb7-adiri-10061842', 'governance-key-rotation-proof-cycle-1786994848', 'governance-key-rotation-execverify-041517',
    ]);
  });

  for (const v of vectors) {
    it(`${v.label}: the transaction hash is its id on chain, the metadata hash is the header's initiator, and the on-chain signature verifies over the signing hash`, () => {
      const r = reconstructSigning(v.transaction, metadataOf(v));
      expect(r.transactionHash).toBe(v.txid.match(/[0-9a-f]{64}/)![0]);
      expect(r.signatureMetadataHash).toBe(v.transaction.header.initiator);
      expect(onChainVerifies(v, r.hashToSign)).toBe(true);
      // and only over that hash
      expect(onChainVerifies(v, r.transactionHash)).toBe(false);
    });
  }
});

describe('verifySigningData accepts exactly what was asked for', () => {
  it('single-leg native transfer: target, value, calldata, chain and principal', () => {
    const v = by('single-leg-native-transfer');
    const s = verifySigningData(gatewaySigningData(v), {
      adiUrl: 'acc://rb7-adiri-10061842.acme',
      signerPublicKey: v.onChainSignature.publicKey,
      signerKeyPage: 'acc://rb7-adiri-10061842.acme/book/1',
      additionalAuthorities: [],
      legs: [{ chainId: 2017, target: '0x32422604b797f0a135d8F28B84Ce72EefA185FC8', value: '1', callData: '0x' }],
    });
    expect(s.kind).toBe('cross-chain intent');
    expect(s.legs).toHaveLength(1);
    expect(s.legs[0]).toMatchObject({ chainId: 2017, valueWei: '1', callDataBytes: 0 });
    expect(s.text.join('\n')).toMatch(/plain transfer to 0x32422604b797f0a135d8F28B84Ce72EefA185FC8, value 1 wei/);
    expect(s.hashes.transaction).toBe(v.txid.match(/[0-9a-f]{64}/)![0]);
  });

  it('single-leg contract call: calldata, value 0 and the event the call must emit', () => {
    const v = by('single-leg-contract-call-with-events');
    const s = verifySigningData(gatewaySigningData(v), {
      adiUrl: 'acc://rb7-adiri-10061842.acme',
      legs: [{
        chainId: 2017,
        target: '0x25ebFbC617e777Ae983a2C22E3B9649E3EB93802',
        value: 0n,
        callData: '0xb69766c2000000000000000000000000000000000000000000000000000000000000002a',
        expectedEvents: [{ contract: '0x25ebFbC617e777Ae983a2C22E3B9649E3EB93802', topic0: '0x259ca58d38581aded59462a9c47af5d03be3ecd093d9c618400f6a24bd0e1e0d' }],
      }],
    });
    expect(s.legs[0].callDataBytes).toBe(36);
    expect(s.legs[0].expectedEvents).toHaveLength(1);
    expect(s.legs[0].expectedStateSlots).toBe(1);
  });

  it('a multi-leg intent: every leg, in order', () => {
    const v = by('four-leg');
    const s = verifySigningData(gatewaySigningData(v), {
      adiUrl: 'acc://rb7-adiri-10061842.acme',
      legs: [{ chainId: 11155111 }, { chainId: 84532 }, { chainId: 421614 }, { chainId: 2017 }].map((l) => ({ ...l, target: '0x32422604b797f0a135d8F28B84Ce72EefA185FC8', value: '1', callData: '0x' })),
    });
    expect(s.legs.map((l) => l.chainId)).toEqual([11155111, 84532, 421614, 2017]);
    expect(s.intentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a governance change: its operations are shown', () => {
    const v = by('governance-key-rotation-rb7-adiri-10061842');
    const s = verifySigningData(gatewaySigningData(v), { adiUrl: 'acc://rb7-adiri-10061842.acme', signerPublicKey: v.onChainSignature.publicKey });
    expect(s.kind).toBe('updateKeyPage');
    expect(s.operations).toHaveLength(1);
    expect(s.text.join('\n')).toMatch(/"type":"update"/);
  });

  it('accepts the signing data of every vector with no expectation but its own hashes (the hashes are still all checked)', () => {
    for (const v of vectors) expect(() => verifySigningData(gatewaySigningData(v))).not.toThrow();
  });
});

describe('what used to be signed, and is refused now (fail-before: a hash for another transaction was signed)', () => {
  const v = by('single-leg-native-transfer');
  const other = by('single-leg-contract-call-with-events');
  const fieldOf = (f: () => unknown) => {
    try { f(); } catch (e) { expect(e).toBeInstanceOf(SigningDataMismatch); expect((e as SigningDataMismatch).code).toBe(SIGNING_DATA_MISMATCH); return (e as SigningDataMismatch).field; }
    throw new Error('was accepted');
  };

  it('a hash_to_sign that is the hash of a different transaction', () => {
    const sd = { ...gatewaySigningData(v), hash_to_sign: gatewaySigningData(other).hash_to_sign };
    expect(fieldOf(() => verifySigningData(sd))).toBe('hash_to_sign');
  });

  it('the bare transaction hash where the signing hash belongs', () => {
    const sd = gatewaySigningData(v);
    expect(fieldOf(() => verifySigningData({ ...sd, hash_to_sign: sd.transaction_hash }))).toBe('hash_to_sign');
  });

  it('the right hash with a body whose leg value was altered', () => {
    const sd = gatewaySigningData(v);
    const altered = JSON.parse(JSON.stringify(v.transaction));
    const blobs = altered.body.entry.data.map((h: string) => JSON.parse(Buffer.from(h, 'hex').toString()));
    blobs[1].legs[0].executionPayload.value = '1000000000000000000';
    altered.body.entry.data = blobs.map((b: unknown) => Buffer.from(JSON.stringify(b)).toString('hex'));
    expect(fieldOf(() => verifySigningData({ ...sd, transaction: altered }))).toMatch(/^(hash_to_sign|transaction_hash)$/);
  });

  it('a consistent lie: a gateway that recomputes the hash for a body with another recipient is caught by what was asked for', () => {
    const altered = JSON.parse(JSON.stringify(v.transaction));
    const blobs = altered.body.entry.data.map((h: string) => JSON.parse(Buffer.from(h, 'hex').toString()));
    blobs[1].legs[0].executionPayload.target = '0x000000000000000000000000000000000000dEaD';
    altered.body.entry.data = blobs.map((b: unknown) => Buffer.from(JSON.stringify(b)).toString('hex'));
    const r = reconstructSigning(altered, metadataOf(v));
    const sd = { transaction_hash: r.transactionHash, hash_to_sign: r.hashToSign, transaction: altered, signature_metadata: metadataOf(v) };
    // every hash is self-consistent, so only the comparison with the request can refuse it
    expect(() => verifySigningData(sd)).not.toThrow();
    const ask: Expectation = { legs: [{ chainId: 2017, target: '0x32422604b797f0a135d8F28B84Ce72EefA185FC8', value: '1', callData: '0x' }] };
    expect(fieldOf(() => verifySigningData(sd, ask))).toBe('legs[0].target');
  });

  it('each leg field is compared: value, calldata, chain, count, event', () => {
    const sd = gatewaySigningData(by('single-leg-contract-call-with-events'));
    const good = { target: '0x25ebFbC617e777Ae983a2C22E3B9649E3EB93802', value: '0', chainId: 2017, callData: '0xb69766c2000000000000000000000000000000000000000000000000000000000000002a' };
    expect(() => verifySigningData(sd, { legs: [good] })).not.toThrow();
    expect(fieldOf(() => verifySigningData(sd, { legs: [{ ...good, value: '1' }] }))).toBe('legs[0].value');
    expect(fieldOf(() => verifySigningData(sd, { legs: [{ ...good, callData: '0xb69766c20000000000000000000000000000000000000000000000000000000000000063' }] }))).toBe('legs[0].callData');
    expect(fieldOf(() => verifySigningData(sd, { legs: [{ ...good, chainId: 84532 }] }))).toBe('legs[0].chainId');
    expect(fieldOf(() => verifySigningData(sd, { legs: [good, good] }))).toBe('legs');
    expect(fieldOf(() => verifySigningData(sd, { legs: [{ ...good, expectedEvents: [{ contract: good.target, topic0: '0x' + '11'.repeat(32) }] }] }))).toBe('legs[0].expectedEvents');
  });

  it('the header: another principal, an unrequested authority, another deadline, the wrong key or page, the wrong intent', () => {
    const sd = gatewaySigningData(v);
    expect(fieldOf(() => verifySigningData(sd, { principal: 'acc://someone-else.acme/data' }))).toBe('transaction.header.principal');
    expect(fieldOf(() => verifySigningData(sd, { adiUrl: 'acc://someone-else.acme' }))).toBe('transaction.header.principal');
    expect(fieldOf(() => verifySigningData(sd, { signerPublicKey: 'ab'.repeat(32) }))).toBe('signature_metadata.public_key');
    expect(fieldOf(() => verifySigningData(sd, { signerKeyPage: 'acc://rb7-adiri-10061842.acme/book/2' }))).toBe('signature_metadata.signer');
    expect(fieldOf(() => verifySigningData(sd, { intentId: '00000000-0000-4000-8000-000000000000' }))).toBe('transaction.body.entry.data[0].intent_id');
    expect(fieldOf(() => verifySigningData(sd, { expiresAt: '2030-01-01T00:00:00Z' }))).toBe('transaction.header.expire.atTime');

    // a header that adds an authority, signed as-is, would make someone else a required signer
    const withAuthority = JSON.parse(JSON.stringify(v.transaction));
    withAuthority.header.authorities = ['acc://attacker.acme/book'];
    const r = reconstructSigning(withAuthority, metadataOf(v));
    const evil = { transaction_hash: r.transactionHash, hash_to_sign: r.hashToSign, transaction: withAuthority, signature_metadata: metadataOf(v) };
    expect(fieldOf(() => verifySigningData(evil, { additionalAuthorities: [] }))).toBe('transaction.header.authorities');
    expect(() => verifySigningData(evil, { additionalAuthorities: ['acc://attacker.acme/book'] })).not.toThrow();
  });

  it('the deadline it asked for is the deadline in the header', () => {
    const withExpiry = JSON.parse(JSON.stringify(v.transaction));
    withExpiry.header.expire = { atTime: '2026-12-01T10:00:00Z' };
    const r = reconstructSigning(withExpiry, metadataOf(v));
    const sd = { transaction_hash: r.transactionHash, hash_to_sign: r.hashToSign, transaction: withExpiry, signature_metadata: metadataOf(v) };
    expect(verifySigningData(sd, { expiresAt: new Date('2026-12-01T10:00:00Z') }).expiresAt).toBe('2026-12-01T10:00:00Z');
    expect(fieldOf(() => verifySigningData(sd, { expiresAt: '2026-12-01T10:05:00Z' }))).toBe('transaction.header.expire.atTime');
  });

  it('a header whose initiator is not the returned signature metadata', () => {
    const sd = gatewaySigningData(v);
    const wrong = JSON.parse(JSON.stringify(v.transaction));
    wrong.header.initiator = 'cd'.repeat(32);
    expect(fieldOf(() => verifySigningData({ ...sd, transaction: wrong }))).toBe('transaction.header.initiator');
  });

  it('metadata changed after the hash was computed (another signer page or timestamp)', () => {
    const sd = gatewaySigningData(v);
    expect(fieldOf(() => verifySigningData({ ...sd, signature_metadata: { ...metadataOf(v), signer: 'acc://rb7-adiri-10061842.acme/book/2' } }))).toBe('transaction.header.initiator');
    expect(fieldOf(() => verifySigningData({ ...sd, signature_metadata: { ...metadataOf(v), timestamp_us: metadataOf(v).timestamp_us + 1 } }))).toBe('transaction.header.initiator');
  });

  it('a transaction_hash that is not the hash of the transaction returned', () => {
    expect(fieldOf(() => verifySigningData({ ...gatewaySigningData(v), transaction_hash: 'ab'.repeat(32) }))).toBe('transaction_hash');
  });

  it('calldata that does not hash to the data hash the leg commits to', () => {
    const t = JSON.parse(JSON.stringify(by('single-leg-contract-call-with-events').transaction));
    const blobs = t.body.entry.data.map((h: string) => JSON.parse(Buffer.from(h, 'hex').toString()));
    blobs[1].legs[0].executionPayload.callData = '0xdeadbeef';
    t.body.entry.data = blobs.map((b: unknown) => Buffer.from(JSON.stringify(b)).toString('hex'));
    const m = metadataOf(by('single-leg-contract-call-with-events'));
    const r = reconstructSigning(t, m);
    expect(fieldOf(() => verifySigningData({ transaction_hash: r.transactionHash, hash_to_sign: r.hashToSign, transaction: t, signature_metadata: m }))).toBe('legs[0].executionPayload.dataHash');
  });

  it('a data write that is not a CERTEN intent, the wrong number of blobs, and a transaction type it cannot describe', () => {
    const base = JSON.parse(JSON.stringify(v.transaction));
    const m = metadataOf(v);
    const sdOf = (t: unknown) => { const r = reconstructSigning(t, m); return { transaction_hash: r.transactionHash, hash_to_sign: r.hashToSign, transaction: t, signature_metadata: m }; };
    const memo = { ...base, header: { ...base.header, memo: 'something else' } };
    expect(fieldOf(() => verifySigningData(sdOf(memo)))).toBe('transaction.header.memo');
    const blobs = { ...base, body: { ...base.body, entry: { ...base.body.entry, data: base.body.entry.data.slice(0, 3) } } };
    expect(fieldOf(() => verifySigningData(sdOf(blobs)))).toBe('transaction.body.entry.data');
    const burn = { header: { principal: 'acc://rb7-adiri-10061842.acme/tokens' }, body: { type: 'burnTokens', amount: '100' } };
    expect(fieldOf(() => verifySigningData(sdOf(burn)))).toBe('transaction.body.type');
  });

  it('signature metadata that is not an ed25519 signature with a valid version, timestamp and vote', () => {
    const sd = gatewaySigningData(v);
    for (const bad of [{ type: 'btc' }, { signer_version: 0 }, { timestamp_us: 0 }, { vote: 'approve' }]) {
      expect(() => verifySigningData({ ...sd, signature_metadata: { ...metadataOf(v), ...bad } })).toThrow(SigningDataMismatch);
    }
  });
});

describe('what the gateway did not send is refused by name, with no way to sign anyway', () => {
  const sd = gatewaySigningData(by('four-leg'));
  const absent = (f: () => unknown) => {
    try { f(); } catch (e) { expect(e).toBeInstanceOf(SigningDataAbsent); expect((e as SigningDataAbsent).code).toBe(SIGNING_DATA_ABSENT); return (e as SigningDataAbsent).missing; }
    throw new Error('was accepted');
  };

  it('no transaction, no signature metadata, no hash', () => {
    expect(absent(() => verifySigningData({ hash_to_sign: sd.hash_to_sign }))).toBe('signing_data.transaction');
    expect(absent(() => verifySigningData({ hash_to_sign: sd.hash_to_sign, transaction: sd.transaction }))).toBe('signing_data.signature_metadata');
    expect(absent(() => verifySigningData({ transaction: sd.transaction, signature_metadata: sd.signature_metadata }))).toBe('signing_data.hash_to_sign');
  });

  it('data_for_signature (POST /v1/sign) is the same bytes under another name', () => {
    const { hash_to_sign, ...rest } = sd;
    expect(() => verifySigningData({ ...rest, data_for_signature: hash_to_sign })).not.toThrow();
  });

  it('exports no switch that skips the check', async () => {
    const exported = Object.keys(await import('../src/index.js'));
    expect(exported.filter((k) => /blind|skip|unsafe|insecure|trust/i.test(k))).toEqual([]);
  });
});

describe('governance changes: what was asked for is what the transaction does', () => {
  const v = by('governance-key-rotation-rb7-adiri-10061842');
  const m = metadataOf(v);
  const KEY = 'aa'.repeat(32);
  const sdFor = (principal: string, body: unknown) => {
    const t = { header: { principal }, body };
    const r = reconstructSigning(t, m);
    return { transaction_hash: r.transactionHash, hash_to_sign: r.hashToSign, transaction: t, signature_metadata: m };
  };
  const page = 'acc://rb7-adiri-10061842.acme/book/1';
  const adi = 'acc://rb7-adiri-10061842.acme';
  const mismatch = (f: () => unknown) => { try { f(); } catch (e) { expect(e).toBeInstanceOf(SigningDataMismatch); return (e as SigningDataMismatch).field; } throw new Error('was accepted'); };

  it('add_key adds exactly that key hash; another hash, or a removal, is refused', () => {
    const sd = sdFor(page, { type: 'updateKeyPage', operation: [{ type: 'add', entry: { keyHash: KEY } }] });
    expect(verifySigningData(sd, { adiUrl: adi, governance: [{ type: 'add_key', public_key_hash: KEY }] }).operations).toHaveLength(1);
    expect(mismatch(() => verifySigningData(sd, { adiUrl: adi, governance: [{ type: 'add_key', public_key_hash: 'bb'.repeat(32) }] }))).toBe('transaction.body.operation');
    expect(mismatch(() => verifySigningData(sd, { adiUrl: adi, governance: [{ type: 'remove_key', public_key_hash: KEY }] }))).toBe('transaction.body.operation');
  });

  it('set_threshold, add_delegate and remove_key map to their Accumulate operations', () => {
    expect(() => verifySigningData(sdFor(page, { type: 'updateKeyPage', operation: [{ type: 'setThreshold', threshold: 2 }] }), { governance: [{ type: 'set_threshold', threshold: '2' }] })).not.toThrow();
    expect(() => verifySigningData(sdFor(page, { type: 'updateKeyPage', operation: [{ type: 'add', entry: { delegate: 'acc://d.acme/book' } }] }), { governance: [{ type: 'add_delegate', delegate_url: 'acc://D.acme/book' }] })).not.toThrow();
    expect(() => verifySigningData(sdFor(page, { type: 'updateKeyPage', operation: [{ type: 'remove', entry: { keyHash: KEY } }] }), { governance: [{ type: 'remove_key', public_key_hash: KEY }] })).not.toThrow();
    expect(mismatch(() => verifySigningData(sdFor(page, { type: 'updateKeyPage', operation: [{ type: 'setThreshold', threshold: 1 }] }), { governance: [{ type: 'set_threshold', threshold: 2 }] }))).toBe('transaction.body.operation');
  });

  it('an authority change is an updateAccountAuth on the account, and a key-page change cannot be passed off as one', () => {
    const body = { type: 'updateAccountAuth', operations: [{ type: 'addAuthority', authority: 'acc://other.acme/book' }] };
    expect(() => verifySigningData(sdFor(adi, body), { adiUrl: adi, governance: [{ type: 'add_authority', authority_url: 'acc://other.acme/book' }] })).not.toThrow();
    expect(mismatch(() => verifySigningData(sdFor(adi, body), { adiUrl: adi, governance: [{ type: 'add_key', public_key_hash: KEY }] }))).toBe('transaction.body.type');
    expect(mismatch(() => verifySigningData(sdFor(adi, body), { adiUrl: adi, governance: [{ type: 'remove_authority', authority_url: 'acc://other.acme/book' }] }))).toBe('transaction.body.operations');
  });

  it('a change outside the identity is refused', () => {
    const sd = sdFor('acc://someone-else.acme/book/1', { type: 'updateKeyPage', operation: [{ type: 'add', entry: { keyHash: KEY } }] });
    expect(mismatch(() => verifySigningData(sd, { adiUrl: adi }))).toBe('transaction.header.principal');
  });

  it('extra operations smuggled alongside the one asked for are refused', () => {
    const sd = sdFor(page, { type: 'updateKeyPage', operation: [{ type: 'add', entry: { keyHash: KEY } }, { type: 'add', entry: { keyHash: 'cc'.repeat(32) } }] });
    expect(mismatch(() => verifySigningData(sd, { governance: [{ type: 'add_key', public_key_hash: KEY }] }))).toBe('transaction.body.operation');
  });
});

describe('co-signing an existing transaction keeps its original initiator', () => {
  const v = by('four-leg');
  const meta = { ...metadataOf(v), signer: 'acc://rb7-adiri-10061842.acme/book/2', signer_version: 1, vote: 'accept' };
  const r = reconstructSigning(v.transaction, meta, true);

  it('hashes the transaction as it is, and signs sha256(new metadata hash || its hash)', () => {
    expect(r.transactionHash).toBe(v.txid.match(/[0-9a-f]{64}/)![0]);
    expect(r.signatureMetadataHash).not.toBe(v.transaction.header.initiator);
    const sd = { data_for_signature: r.hashToSign, transaction_hash: r.transactionHash, transaction: v.transaction, signature_metadata: meta };
    expect(() => verifySigningData(sd, { transactionHash: r.transactionHash, signerKeyPage: meta.signer, vote: 'approve' }, { existing: true })).not.toThrow();
    expect(() => verifySigningData(sd, { vote: 'reject' }, { existing: true })).toThrow(SigningDataMismatch);
  });

  it('is refused as a NEW transaction, and for the wrong transaction hash', () => {
    const sd = { data_for_signature: r.hashToSign, transaction: v.transaction, signature_metadata: meta };
    expect(() => verifySigningData(sd)).toThrow(SigningDataMismatch);
    expect(() => verifySigningData(sd, { transactionHash: 'ab'.repeat(32) }, { existing: true })).toThrow(SigningDataMismatch);
  });
});
