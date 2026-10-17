import { createHash } from 'node:crypto';
import { core } from 'accumulate-sdk-opendlt';
import { encode } from 'accumulate-sdk-opendlt/encoding';
import { describe, expect, it } from 'vitest';
import { SCHEMA_COMMIT } from '../src/sigtypes/eip712-schema.js';
import { ACCEPTED_KEY_TYPES, decodeSignature, encodeNode } from '../src/sigtypes/index.js';
import { fromHex, judge, manifest, readFixture as read, toHex, vectors } from './helpers/sigtypes.js';

/**
 * Every key-signature type Accumulate accepts, against the validator's Go implementation (liteclient/proof/govsig).
 *
 * Go writes the vectors (cmd/sigtypevectors) and every verdict in them was produced by Accumulate's own
 * protocol.VerifyUserSignature through govsig.Verify. The files here are byte-identical copies, pinned by the manifest's
 * hashes. This suite decodes each signature from its binary encoding, verifies it with the TypeScript rule, and must reach the
 * same verdict, the same key hash, the same digest form, the same eth rule, the same inner type and the same delegators on all
 * 154. A difference is a stop-the-line finding; it is never "fixed" by editing a vector.
 */
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** The manifest hash of the Go-written files this suite was written against (govsig testdata/sigtypes/manifest.json, validator pv2/rb8-b-every-key-signature-type). */
const MANIFEST_HASH = '032b15bd27254856c05ca104d1aa16e73eb0fcb8b1136abf98bbe0ab5f80579c';

describe('the shared vectors are the ones Go wrote', () => {
  it('every file hashes to what the manifest pins, and the manifest to the hash this suite was written against', () => {
    for (const f of manifest.files) expect(sha(read(f.name)), f.name).toBe(f.sha256);
    const h = createHash('sha256');
    for (const f of manifest.files) h.update(`${f.name}:${f.sha256}\n`);
    expect(h.digest('hex')).toBe(manifest.manifestHash);
    expect(manifest.manifestHash).toBe(MANIFEST_HASH);
    expect(manifest.format).toBe('certen:sigtypes-manifest:v1');
  });

  it('was written against the Accumulate commit Kermit runs, the one the EIP-712 type table was read from', () => {
    const pinned = (JSON.parse(read('valid.json').toString('utf8')) as { pinned: { commit: string; network: string; chainId: string } }).pinned;
    expect(pinned.commit).toBe('e1d1db9ebb7c75318b6652293d5c7008da76ecf4');
    expect(SCHEMA_COMMIT).toBe(pinned.commit);
    expect(pinned.network).toBe('DevNet');
    expect(pinned.chainId).toBe('317849881');
  });

  it('has the 154 vectors the manifest counts, none twice, from the two sources', () => {
    expect(vectors.length).toBe(154);
    expect(vectors.length).toBe(manifest.vectors);
    expect(new Set(vectors.map((v) => v.id)).size).toBe(vectors.length);
    for (const f of manifest.files) expect((JSON.parse(read(f.name).toString('utf8')) as { vectors: unknown[] }).vectors.length).toBe(f.vectors);
    expect(vectors.filter((v) => v.source === 'kermit-delivered').length).toBe(manifest.sources['kermit-delivered']);
    expect(vectors.filter((v) => v.source === 'locally-generated').length).toBe(manifest.sources['locally-generated']);
    expect(manifest.sources['kermit-delivered']).toBe(4);
  });

  it('covers what RB8 Phase B item 7 names, for every accepted type', () => {
    const have = new Set(vectors.map((v) => v.id));
    for (const ty of ACCEPTED_KEY_TYPES) {
      for (const want of ['valid/direct', 'valid/delegated-1', 'valid/delegated-2', 'adversarial/wrong-transaction', 'adversarial/flipped-bit', 'adversarial/wrong-key-on-page']) {
        expect(have.has(`${ty}/${want}`), `${ty}/${want}`).toBe(true);
      }
    }
    for (const id of [
      'btc/kermit/case-k',
      'ecdsaSha256/kermit/northfield-inspection',
      'ed25519/adversarial/s-plus-l',
      'ecdsaSha256/adversarial/brainpool-key',
      'rsaSha256/adversarial/pkix-key',
      'typedData/adversarial/different-transaction',
      'typedData/adversarial/chain-id-1',
      'ed25519/valid/delegated-20',
      'ed25519/adversarial/delegated-21',
      'eth/adversarial/der-after-baikonur',
      'eth/valid/v1-der-before-activation',
      'non-key/authority',
      'non-key/delegated-authority',
      'ed25519/valid/reject-vote',
      'ecdsaSha256/valid/high-s',
      'btc/valid/lax-der-trailing-bytes',
      'label-swap/ed25519-bytes-as-ecdsaSha256',
      'label-swap/ecdsa-bytes-as-ed25519',
      'ecdsaSha256/gate/before-activation',
      'typedData/gate/before-activation',
      'rsaSha256/gate/no-location',
    ]) {
      expect(have.has(id), id).toBe(true);
    }
  });

  it('names the nine types Accumulate accepts, with Accumulate\'s own spellings', () => {
    expect([...ACCEPTED_KEY_TYPES].sort()).toEqual(['btc', 'btclegacy', 'ecdsaSha256', 'ed25519', 'eth', 'legacyED25519', 'rcd1', 'rsaSha256', 'typedData']);
  });
});

describe('every vector reaches Go\'s verdict, key hash and digest form', () => {
  for (const v of vectors) {
    it(`${v.id} -> ${v.expect.verdict}${v.expect.form ? ` (${v.expect.form})` : ''}`, () => {
      const got = judge(v);
      expect(got.verdict, `${v.description}${got.error instanceof Error ? ` :: ${got.error.message}` : ''}`).toBe(v.expect.verdict);
      if (v.expect.verdict === 'accepted') {
        expect(got.keyHash).toBe(v.expect.keyHash!.toLowerCase());
        expect(got.form).toBe(v.expect.form);
        expect(got.ethRule).toBe(v.expect.ethRule ?? '');
        expect(got.innerType).toBe(v.expect.innerType ?? v.type);
        expect(got.delegators).toEqual(v.expect.delegators ?? []);
      }
    });
  }
});

describe('the binary and JSON forms of each vector are one signature', () => {
  // The SDK's encoder is exercised on every vector that carries a user's key signature; for the non-key kinds (receipt, authority,
  // ...) accumulate-sdk-opendlt 2.5.2 encodes an unset nested proof that Accumulate leaves out, which no verification here reads.
  for (const v of vectors.filter((x) => x.signatureJson)) {
    const key = v.expect.verdict !== 'refused:not_a_key_signature';
    it(`${v.id}: decode-then-encode returns the same bytes${key ? ', and the SDK encodes the served JSON to them' : ''}`, () => {
      expect(toHex(encodeNode(decodeSignature(fromHex(v.signature))))).toBe(v.signature.toLowerCase());
      if (key) expect(Buffer.from(encode(core.Signature.fromObject(v.signatureJson))).toString('hex')).toBe(v.signature.toLowerCase());
    });
  }
});

describe('the vectors are not vacuous', () => {
  it('has the verdict mix Go produced: accepted, rejected, named states, and every non-key kind', () => {
    const mix: Record<string, number> = {};
    for (const v of vectors) mix[v.expect.verdict] = (mix[v.expect.verdict] ?? 0) + 1;
    expect(mix).toEqual({
      accepted: 67,
      'refused:signature_invalid': 39,
      'refused:key_not_on_page': 15,
      'refused:delegation_depth_exceeded': 3,
      'refused:executor_gate_not_met': 1,
      'refused:typed_data_chain_id_mismatch': 2,
      'named:network_name_unproven': 1,
      'named:g1_executor_version_unproven': 14,
      'refused:not_a_key_signature': 12,
    });
    expect(vectors.filter((v) => v.expect.form === 'initiator-merkle').length).toBe(6);
    expect(vectors.filter((v) => v.expect.form === 'eip712').length).toBe(5);
    expect(vectors.filter((v) => v.expect.form === 'v1-rule').length).toBe(1);
  });
});
