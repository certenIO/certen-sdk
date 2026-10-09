/**
 * The Accumulate validator-set root, certen:accval:v1 (certen-validator pkg/execution/contracts
 * ComputeAccumulateValidatorSetRoot, reached through pkg/accumulateset AccumulateSetRoot): the set and accept threshold
 * a V8.2 anchor commits, under an incarnation. The proof v2 verifier reports it for the set the spine derived.
 */
import { keccak256 } from './accumulate.js';
import { equal, fail, hexBytes } from './bytes.js';
import { rec, type Rec } from './shapes.js';

const DOMAIN = 'certen:accval:v1';

export interface AccumulateValidator {
  /** The validator's ed25519 public key, hex32. */
  publicKey: string;
  /** The partitions the validator is active on, case preserved; order is normalised by the root. */
  activeOn: string[];
}

export interface Threshold {
  numerator: number | bigint;
  denominator: number | bigint;
}

function u64be(n: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

/** Go's bytes.Compare and sort.Strings order: unsigned bytes, UTF-8 for strings. */
function byteOrder(a: Uint8Array, b: Uint8Array): number {
  return Buffer.compare(a, b);
}

/**
 * keccak256("certen:accval:v1" || incarnation || u64(num) || u64(den) || u32(n) || per validator sorted by key:
 * key || u32(m) || per partition sorted: u32(len) || partition). Every refusal is Go's.
 */
export function accumulateSetRoot(validators: AccumulateValidator[], threshold: Threshold, incarnation: string): string {
  // accumulateset.AccumulateSetRootInputs: a non-empty set, every key 32 bytes of hex.
  if (validators.length === 0) fail('accumulate validator set: empty');

  const vals = validators.map((v, i) => {
    const t = typeof v.publicKey === 'string' ? v.publicKey.trim().toLowerCase().replace(/^0x/, '') : '';
    if (!/^[0-9a-f]{64}$/.test(t)) fail(`accumulate validator set: validator ${i}: public key must be 32 bytes of hex`);
    return { key: new Uint8Array(Buffer.from(t, 'hex')), activeOn: [...v.activeOn] };
  });
  // ComputeAccumulateValidatorSetRoot.
  const inc = hexBytes(incarnation, 'accumulate validator-set root: incarnation', 32);
  if (equal(inc, new Uint8Array(32))) {
    fail('accumulate validator-set root: incarnation is required (a root that cannot say which chain it is about is not a commitment)');
  }
  const num = BigInt(threshold.numerator);
  const den = BigInt(threshold.denominator);
  if (den === 0n) fail('accumulate validator-set root: zero threshold denominator');
  if (num === 0n) fail('accumulate validator-set root: zero threshold numerator would admit an unsigned anchor');
  if (num > den) fail(`accumulate validator-set root: threshold numerator ${num} exceeds denominator ${den}`);
  vals.sort((a, b) => byteOrder(a.key, b.key));
  for (let i = 1; i < vals.length; i++) {
    if (equal(vals[i].key, vals[i - 1].key)) {
      fail(`accumulate validator-set root: duplicate public key ${Buffer.from(vals[i].key.slice(0, 8)).toString('hex')}`);
    }
  }

  const parts: Uint8Array[] = [Buffer.from(DOMAIN), inc, u64be(num), u64be(den), u32be(vals.length)];
  for (const v of vals) {
    parts.push(v.key);
    const names = v.activeOn.map((p) => new Uint8Array(Buffer.from(p, 'utf8')));
    names.sort(byteOrder);
    for (let i = 1; i < names.length; i++) {
      if (equal(names[i], names[i - 1])) {
        fail(`accumulate validator-set root: validator ${Buffer.from(v.key.slice(0, 8)).toString('hex')} lists partition ${JSON.stringify(Buffer.from(names[i]).toString('utf8'))} twice`);
      }
    }
    parts.push(u32be(names.length));
    for (const p of names) parts.push(u32be(p.length), p);
  }
  return Buffer.from(keccak256(Buffer.concat(parts))).toString('hex');
}

/**
 * pkg/proof decodeValidators: the set a NetworkDefinition (as JSON) carries, each validator active on the partitions
 * it is marked active on.
 */
export function validatorsOf(network: unknown): AccumulateValidator[] {
  const vs = network && typeof network === 'object' ? (network as Rec).validators : undefined;
  if (!Array.isArray(vs) || vs.length === 0) fail('network account: NetworkDefinition carries no validators');
  return vs.map((validator: unknown, i: number) => {
    const v = rec(validator, `validator ${i}`);
    const pk = hexBytes(v.publicKey, `validator ${i} publicKey`);
    if (pk.length !== 32) fail(`network account: validator ${i} has a ${pk.length}-byte public key, expected 32`);
    const parts = Array.isArray(v.partitions) ? (v.partitions as Rec[]) : [];
    return { publicKey: Buffer.from(pk).toString('hex'), activeOn: parts.filter((p) => p?.active === true).map((p) => String(p.id ?? '')) };
  });
}
