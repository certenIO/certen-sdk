import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeSignature,
  decodeTransaction,
  ethChainId,
  eip712Hash,
  executorFloor,
  KERMIT_ACTIVATIONS,
  checkExecutorGate,
  ExecutorGateNotMet,
  ExecutorVersionUnproven,
  initiatorHash,
  metadataHash,
  NotKeySignature,
  SigtypeError,
  verdictOf,
  verifyKeySignature,
  WireError,
  encodeNode,
  type VerifyEnv,
} from '../src/sigtypes/index.js';
import { ed25519Verify } from '../src/sigtypes/curves.js';
import { laxSecp256k1Signature, parsePkcs1Rsa, parseSpkiEcdsa, readTlv, strictEcdsaSignature } from '../src/sigtypes/der.js';

/**
 * The rules of the TypeScript half that the 154 shared vectors reach only through whole signatures, pinned one at a time. Each
 * says which Go function or file it stands for; none invents a rule. The vectors remain the oracle for verdicts.
 */
const dir = new URL('./fixtures/sigtypes/', import.meta.url);
interface V {
  id: string;
  transaction?: string;
  txHash: string;
  signature: string;
  signatureJson: Record<string, unknown>;
  networkName?: string;
  where?: { partition: string; block: number };
}
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')) as { files: { name: string }[] };
const all: V[] = manifest.files.flatMap((f) => (JSON.parse(readFileSync(new URL(f.name, dir), 'utf8')) as { vectors: V[] }).vectors);
const vec = (id: string): V => {
  const v = all.find((x) => x.id === id);
  if (!v) throw new Error(`no vector ${id}`);
  return v;
};
const hex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));
const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const envOf = (v: V, over: Partial<VerifyEnv> = {}): VerifyEnv => ({
  txHash: hex(v.txHash),
  transaction: v.transaction ? decodeTransaction(hex(v.transaction)) : undefined,
  networkName: v.networkName,
  where: v.where,
  ...over,
});

describe('the executor-version gate (govsig gate.go)', () => {
  it('proves a version only after a partition\'s activation block, never at it, never without a location', () => {
    const dn = KERMIT_ACTIVATIONS.directory!;
    expect(executorFloor('directory', dn.block)).toBeUndefined();
    expect(executorFloor('directory', dn.block + 1)).toBe(9);
    expect(executorFloor('dn', dn.block + 1)).toBe(9);
    expect(executorFloor('DN.acme', dn.block + 1)).toBe(9);
    expect(executorFloor('BVN1', KERMIT_ACTIVATIONS.bvn1!.block + 1)).toBe(9);
    expect(executorFloor('bvn9', 99_999_999)).toBeUndefined();
    expect(executorFloor('', 99_999_999)).toBeUndefined();
    // a block is a block of ONE partition: the Directory's block number says nothing about a BVN
    expect(executorFloor('bvn1', dn.block + 1)).toBeUndefined();
  });

  it('applies the gate to rsaSha256, ecdsaSha256, typedData and the eth raw rule only', () => {
    const after = { partition: 'bvn1', block: KERMIT_ACTIVATIONS.bvn1!.block + 1 };
    const before = { partition: 'bvn1', block: KERMIT_ACTIVATIONS.bvn1!.block };
    for (const t of ['rsaSha256', 'ecdsaSha256', 'typedData']) {
      expect(() => checkExecutorGate(t, '', after)).not.toThrow();
      expect(() => checkExecutorGate(t, '', before)).toThrow(ExecutorVersionUnproven);
      expect(() => checkExecutorGate(t, '', undefined)).toThrow(ExecutorVersionUnproven);
    }
    for (const t of ['ed25519', 'legacyED25519', 'rcd1', 'btc', 'btclegacy']) expect(() => checkExecutorGate(t, '', undefined), t).not.toThrow();
    expect(() => checkExecutorGate('eth', 'v2-rsv', undefined)).toThrow(ExecutorVersionUnproven);
    expect(() => checkExecutorGate('eth', 'v2-rsv', after)).not.toThrow();
    // the pre-Baikonur DER form: acceptable while the version is not proven to be later, impossible once it is
    expect(() => checkExecutorGate('eth', 'v1-der', undefined)).not.toThrow();
    expect(() => checkExecutorGate('eth', 'v1-der', after)).toThrow(ExecutorGateNotMet);
  });

  it('names its states with the vectors\' vocabulary and carries the partition and block it judged at', () => {
    try {
      checkExecutorGate('ecdsaSha256', '', { partition: 'dn', block: 5 });
      expect.unreachable();
    } catch (e) {
      expect(verdictOf(e)).toBe('named:g1_executor_version_unproven');
      const u = e as ExecutorVersionUnproven;
      expect([u.partition, u.block, u.type, u.needs, u.earliestKnown]).toEqual(['directory', 5, 'ecdsaSha256', 'v2-vandenberg', KERMIT_ACTIVATIONS.directory!.block]);
      expect(u.message).toContain('g1_executor_version_unproven');
      expect(u.message).toContain('NOT a governance rejection');
    }
  });

  it('derives the EIP-155 chain id as Accumulate does (EthChainID)', () => {
    expect(ethChainId('DevNet')).toBe(317849881n);
    expect(ethChainId('devnet')).toBe(317849881n);
    expect(ethChainId('mainnet')).toBe(281n);
    expect(ethChainId('MainNet')).toBe(281n);
    expect(ethChainId('Kermit')).not.toBe(ethChainId('DevNet'));
  });
});

describe('the DER readers each accept what their Go parser accepts', () => {
  // SEQUENCE { INTEGER 1, INTEGER 2 }
  const ok = hex('3006020101020102');
  it('strict (crypto/ecdsa.VerifyASN1): minimal positive integers, the SEQUENCE is the whole input', () => {
    expect(strictEcdsaSignature(ok)).toEqual({ r: 1n, s: 2n });
    expect(strictEcdsaSignature(hex('300702010102010200'))).toBeUndefined(); // a byte inside the SEQUENCE after s
    expect(strictEcdsaSignature(hex('300602010102010200'))).toBeUndefined(); // a byte after the SEQUENCE
    expect(strictEcdsaSignature(hex('300702020001020102'))).toBeUndefined(); // non-minimal integer (00 01)
    expect(strictEcdsaSignature(hex('3006020180020102'))).toBeUndefined(); // negative
    expect(strictEcdsaSignature(hex('3003020100'))).toBeUndefined(); // one integer
    expect(strictEcdsaSignature(hex('30820006020101020102'))).toBeUndefined(); // a length that should have been short
    expect(strictEcdsaSignature(hex('3080020101020102'))).toBeUndefined(); // indefinite length
    expect(strictEcdsaSignature(new Uint8Array(0))).toBeUndefined();
  });

  it('lax (pkg/crypto.ParseSignature): at least 8 bytes, the tags and fitting lengths are checked and nothing else: trailing bytes, non-minimal and unsigned integers pass', () => {
    const base = hex('3008020101020102aaaa'); // trailing bytes, a SEQUENCE length that is not the data length
    expect(laxSecp256k1Signature(base)).toEqual({ r: 1n, s: 2n });
    expect(laxSecp256k1Signature(hex('300902020001020102aaaa'))).toEqual({ r: 1n, s: 2n }); // non-minimal r
    expect(laxSecp256k1Signature(hex('3008020180020102aaaa'))).toEqual({ r: 0x80n, s: 2n }); // r is unsigned
    expect(laxSecp256k1Signature(hex('3008020001020102aaaa'))).toBeUndefined(); // empty r: Go indexes rBytes[0] and panics
    expect(laxSecp256k1Signature(hex('31080201010201020000'))).toBeUndefined(); // not a SEQUENCE
    expect(laxSecp256k1Signature(hex('3008030101020102aaaa'))).toBeUndefined(); // r is not an INTEGER
    expect(laxSecp256k1Signature(hex('30ff020101020102aaaa'))).toBeUndefined(); // length longer than the data
  });

  it('x509 reads of a PKIX EC key and a PKCS#1 RSA key refuse the other\'s format and anything after the SEQUENCE', () => {
    const ec = hex((vec('ecdsaSha256/valid/direct').signatureJson as { publicKey: string }).publicKey);
    expect(parseSpkiEcdsa(ec)?.curve).toBe('P-256');
    expect(parseSpkiEcdsa(new Uint8Array([...ec, 0]))).toBeUndefined(); // trailing data
    const rsa = hex((vec('rsaSha256/valid/direct').signatureJson as { publicKey: string }).publicKey);
    expect(parsePkcs1Rsa(rsa)?.e).toBe(65537);
    expect(parsePkcs1Rsa(new Uint8Array([...rsa, 0]))).toBeUndefined();
    expect(parseSpkiEcdsa(rsa)).toBeUndefined();
    expect(parsePkcs1Rsa(ec)).toBeUndefined();
    const pkix = hex((vec('rsaSha256/adversarial/pkix-key').signatureJson as { publicKey: string }).publicKey);
    expect(parsePkcs1Rsa(pkix)).toBeUndefined();
    expect(parseSpkiEcdsa(pkix)).toBeUndefined(); // an RSA PKIX key is not an EC key
    expect(readTlv(new Uint8Array([0x30]))).toBeUndefined();
  });
});

describe('crypto/ed25519.Verify, rule by rule', () => {
  const v = vec('ed25519/valid/direct');
  const j = v.signatureJson as { publicKey: string; signature: string };
  // The signed digest is sha256(metadataHash || txHash); recompute it with the verifier's own pieces.
  const digestOf = (): Uint8Array => {
    const sig = decodeSignature(hex(v.signature));
    return new Uint8Array(createHash('sha256').update(metadataHash(sig)).update(hex(v.txHash)).digest());
  };
  it('accepts the signature, and refuses a changed message, key length, signature length and a scalar with the top bits set', () => {
    const pub = hex(j.publicKey);
    const sig = hex(j.signature);
    const d = digestOf();
    expect(ed25519Verify(pub, d, sig)).toBe(true);
    expect(ed25519Verify(pub, new Uint8Array(32), sig)).toBe(false);
    expect(ed25519Verify(pub.subarray(1), d, sig)).toBe(false);
    expect(ed25519Verify(pub, d, sig.subarray(1))).toBe(false);
    const top = new Uint8Array(sig);
    top[63] = top[63]! | 0x20; // sig[63]&224 != 0
    expect(ed25519Verify(pub, d, top)).toBe(false);
  });
});

describe('Accumulate\'s binary encoding, read as its reader reads it', () => {
  const v = vec('ed25519/valid/direct');
  const sigBytes = hex(v.signature);

  it('round-trips every vector\'s signature and keeps the trailing unknown fields Accumulate keeps', () => {
    const withExtra = new Uint8Array([...sigBytes, 0x14, 0x01, 0xaa]);
    const node = decodeSignature(withExtra)!;
    expect(toHex(node.extra)).toBe('1401aa');
    expect(toHex(encodeNode(node))).toBe(toHex(withExtra));
    // extraData is part of what Accumulate hashes, so a signature with it appended does not verify
    expect(toHex(metadataHash(node))).not.toBe(toHex(metadataHash(decodeSignature(sigBytes))));
    try {
      verifyKeySignature(node, envOf(v));
      expect.unreachable();
    } catch (e) {
      expect(verdictOf(e)).toBe('refused:signature_invalid');
    }
  });

  it('refuses what Accumulate\'s reader refuses, as undecodable', () => {
    expect(() => decodeSignature(sigBytes.subarray(0, sigBytes.length - 1))).toThrow(WireError); // a value shorter than its length
    expect(() => decodeSignature(new Uint8Array(0))).toThrow(WireError);
    expect(() => decodeSignature(Uint8Array.of(0x01, 0x00))).toThrow(WireError); // type unknown
    expect(() => decodeSignature(Uint8Array.of(0x01, 0x63))).toThrow(WireError); // a type that does not exist
    expect(() => decodeSignature(Uint8Array.of(0x02, 0x02))).toThrow(WireError); // the first field is not the type
    // fields out of order: type, then field 4 (signer), then field 3 (signature)
    expect(() => decodeSignature(Uint8Array.of(0x01, 0x02, 0x04, 0x01, 0x61, 0x03, 0x01, 0x62))).toThrow(WireError);
    // a field number above 32
    expect(() => decodeSignature(Uint8Array.of(0x01, 0x02, 0x21, 0x00))).toThrow(WireError);
    // a boolean that is neither 0 nor 1 is only reachable through a bool field; a vote that is not a vote:
    expect(() => decodeSignature(Uint8Array.of(0x01, 0x02, 0x07, 0x09))).toThrow(WireError);
    const t = decodeTransaction(hex(vec('typedData/valid/direct').transaction!));
    expect(toHex(encodeNode(t))).toBe(vec('typedData/valid/direct').transaction);
  });

  it('reads the empty object as no signature at all, as Accumulate returns a nil Signature with no error, and that is not a key signature', () => {
    for (const empty of [Uint8Array.of(0x80), Uint8Array.of(0x80, 0xff), Uint8Array.of(0x00), Uint8Array.of(0x00, 0x01, 0x02)]) {
      expect(decodeSignature(empty)).toBeNull();
      try {
        verifyKeySignature(decodeSignature(empty), envOf(v));
        expect.unreachable();
      } catch (e) {
        expect(verdictOf(e)).toBe('refused:not_a_key_signature');
        expect((e as Error).message).toContain('type: nil');
      }
    }
  });

  it('parses URLs as Accumulate does, refusing what its URL parser refuses and writing back the form it writes', () => {
    // a signer URL with a control character, a wrong scheme, a missing host: the whole signature is undecodable
    const withSigner = (signer: string): Uint8Array => {
      const node = decodeSignature(sigBytes)!;
      const bytes = encodeNode(node);
      const old = new TextEncoder().encode('acc://probe.acme/book/1');
      const at = Buffer.from(bytes).indexOf(Buffer.from(old));
      const next = new TextEncoder().encode(signer);
      return Uint8Array.from([...bytes.subarray(0, at - 1), next.length, ...next, ...bytes.subarray(at + old.length)]);
    };
    expect(toHex(withSigner('acc://probe.acme/book/1'))).toBe(toHex(sigBytes));
    for (const bad of ['abc://probe.acme/book/1', 'acc://probe.acme/book/1', 'acc:/-probe.acme/book/1', 'acc://pro{be.acme/book/1', 'acc://probe.acme%zz/book/1']) {
      expect(() => decodeSignature(withSigner(bad)), bad).toThrow(WireError);
    }
    // a spelling Accumulate normalises is written back normalised (the metadata hash is over the normalised form): the scheme may
    // be omitted, a trailing slash is dropped, and percent-escapes are re-encoded
    expect(decodeSignature(withSigner('probe.acme/book/1'))!.fields.get('signer')).toBe('acc://probe.acme/book/1');
    expect(decodeSignature(withSigner('ACC://probe.acme/book/1/'))!.fields.get('signer')).toBe('acc://probe.acme/book/1');
    expect(decodeSignature(withSigner('acc://probe.acme/book/a%20b'))!.fields.get('signer')).toBe('acc://probe.acme/book/a%20b');
    expect(decodeSignature(withSigner('acc://probe.acme//book/1'))!.fields.get('signer')).toBe('acc://probe.acme/book/1');
  });

  it('is not a key signature when it is a signature of another kind, whatever it carries', () => {
    const r = decodeSignature(hex(vec('non-key/receipt').signature));
    expect(() => verifyKeySignature(r, envOf(vec('non-key/receipt')))).toThrow(NotKeySignature);
    try {
      verifyKeySignature(r, envOf(vec('non-key/receipt')));
    } catch (e) {
      expect(e).toBeInstanceOf(SigtypeError);
      expect((e as Error).message).toContain('legacyED25519, ed25519, rcd1, btc, btclegacy, eth, rsaSha256, ecdsaSha256, typedData');
    }
  });
});

describe('typedData cannot be judged without the whole transaction, nor against a different one', () => {
  const v = vec('typedData/valid/direct');
  it('is a named state, not a rejection, when the transaction is absent', () => {
    try {
      verifyKeySignature(decodeSignature(hex(v.signature)), envOf(v, { transaction: undefined }));
      expect.unreachable();
    } catch (e) {
      expect(verdictOf(e)).toBe('named:transaction_unavailable_for_typed_data');
    }
  });

  it('refuses a transaction that is not the governed one (it must hash to the proven transaction hash)', () => {
    const other = decodeTransaction(hex(vec('typedData/adversarial/different-transaction').transaction!));
    try {
      verifyKeySignature(decodeSignature(hex(v.signature)), envOf(v, { transaction: other }));
      expect.unreachable();
    } catch (e) {
      expect(verdictOf(e)).toBe('refused:other');
      expect((e as Error).message).toContain('hashes to');
    }
  });
});

describe('a delegated typedData signature with no delegator has no EIP-712 digest', () => {
  // Accumulate's NewEIP712Call dereferences the delegator (signature_eip712.go:110) and panics, so such a signature can never be
  // accepted; the digest is refused here, not computed over an empty delegator.
  it('refuses to form the digest', () => {
    const v = vec('typedData/valid/delegated-1');
    const sig = decodeSignature(hex(v.signature))!;
    expect(sig.cls).toBe('DelegatedSignature');
    sig.fields.delete('delegator');
    expect(() => eip712Hash(decodeTransaction(hex(v.transaction!)), sig)).toThrow(/no delegator/);
    try {
      verifyKeySignature(sig, envOf(v));
      expect.unreachable();
    } catch (e) {
      expect(verdictOf(e)).toBe('refused:signature_invalid');
    }
  });
});

describe('digests', () => {
  it('forms the initiator merkle hash only for a signature that can initiate', () => {
    expect(initiatorHash(decodeSignature(hex(vec('ed25519/valid/direct-initiator-merkle').signature)))).toBeDefined();
    expect(initiatorHash(decodeSignature(hex(vec('rsaSha256/valid/direct').signature)))).toBeUndefined();
    expect(initiatorHash(decodeSignature(hex(vec('ecdsaSha256/valid/direct').signature)))).toBeUndefined();
    // a delegator is part of what is hashed
    expect(toHex(initiatorHash(decodeSignature(hex(vec('ed25519/valid/delegated-1').signature)))!)).not.toBe(
      toHex(initiatorHash(decodeSignature(hex(vec('ed25519/valid/direct-initiator-merkle').signature)))!),
    );
  });
});
