/**
 * Twin of the validator's codec_cut_test.go: a cut of the container body at ANY byte is refused by the field the cut falls in. The expected
 * `part` and `reason` are derived here from the grammar of V2_SPEC_S7 3.3 (field order and widths), not from the decoder, so a decoder that
 * skips a check and fails later (naming another part) is caught; and a blob whose length prefix is not the blob size is refused in its own part.
 */
import { describe, expect, it } from 'vitest';
import { defaultLimits, encodeNodes } from '../../../src/proof-v2/finality/codec.js';
import { Layout, ProfileLC } from '../../../src/proof-v2/finality/ethl1/index.js';
import { BLOB_BYTES, DataBlobs, DataCalldata, DataNone, decodeEvidence, defaultBounds, encodeEvidence, type Evidence } from '../../../src/proof-v2/finality/arbposted/wire.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';

interface CutField {
  name: string;
  typ: 0 | 1 | 2; // 0 fixed, 1 length-prefixed, 2 count
  n: number; // fixed width, length of the lp data, or the element count
  min: number; // minimum element width of a count
}
const size = (c: CutField): number => (c.typ === 1 ? 4 + c.n : c.typ === 2 ? 4 : c.n);

function cutFields(e: Evidence): CutField[] {
  const f: CutField[] = [];
  const fixed = (name: string, n: number): void => void f.push({ name, typ: 0, n, min: 0 });
  const lp = (name: string, data: Uint8Array | string): void => void f.push({ name, typ: 1, n: typeof data === 'string' ? Buffer.byteLength(data) : data.length, min: 0 });
  const count = (name: string, n: number, min: number): void => void f.push({ name, typ: 2, n, min });
  const lb = (name: string, b: { ssz: Uint8Array }): void => {
    fixed(`${name}.layout`, 1);
    lp(name, b.ssz);
  };
  lp('lc.profile', e.lc.profile);
  fixed('lc.anchorKind', 1);
  fixed('lc.anchorPeriod', 8);
  fixed('lc.anchorRoot', 32);
  lb('lc.anchorBody', e.lc.anchorBody);
  count('lc.links', e.lc.links.length, 5);
  for (const l of e.lc.links) lb('lc.link', l);
  lb('lc.finalUpdate', e.lc.finalUpdate);
  count('l1Spine', e.l1Spine.length, 4);
  for (const h of e.l1Spine) lp('l1Spine', h);
  fixed('stateBlock', 8);
  count('blockTxs', e.blockTxs.length, 4);
  for (const t of e.blockTxs) lp('blockTxs', t);
  fixed('batchSeq', 8);
  for (let i = 0; i < 5; i++) fixed('header40', 8);
  fixed('beforeAcc', 32);
  fixed('delayedAcc', 32);
  fixed('dataKind', 1);
  if (e.dataKind === DataBlobs) {
    count('versionedHashes', e.versionedHashes.length, 32);
    for (let i = 0; i < e.versionedHashes.length; i++) fixed('versionedHashes', 32);
    count('blobs', e.blobs.length, 4 + BLOB_BYTES + 96);
    for (const b of e.blobs) {
      lp('blobs.raw', b.raw);
      fixed('blobs.commitment', 48);
      fixed('blobs.proof', 48);
    }
  } else if (e.dataKind === DataCalldata) {
    lp('calldata', e.calldata);
  }
  fixed('delayedFlag', 1);
  if (e.delayed !== null) {
    fixed('delayed.msgKind', 1);
    fixed('delayed.sender', 20);
    fixed('delayed.msgBlockNumber', 8);
    fixed('delayed.msgTimestamp', 8);
    fixed('delayed.baseFeeL1', 32);
    lp('delayed.data', e.delayed.data);
    fixed('delayed.k', 8);
  }
  const nodes = encodeNodes(e.nodes); // sorted into the canonical order, as the encoder writes them
  count('nodes', nodes.length, 4);
  for (const n of nodes) lp('nodes', n);
  return f;
}

/** the part and reason the decoder must name for the body cut to `cut` bytes; part '' when the cut is the whole body */
function wantPart(fields: CutField[], cut: number): [string, string] {
  let pos = 0;
  for (const f of fields) {
    if (f.typ === 0) {
      if (cut < pos + f.n) return [f.name, 'truncated'];
      pos += f.n;
    } else if (f.typ === 1) {
      if (cut < pos + 4) return [`${f.name}.len`, 'truncated'];
      if (cut < pos + 4 + f.n) return [f.name, 'length_exceeds_remaining'];
      pos += 4 + f.n;
    } else {
      if (cut < pos + 4) return [`${f.name}.count`, 'truncated'];
      pos += 4;
      if (f.n * f.min > cut - pos) return [f.name, 'count_exceeds_remaining'];
    }
  }
  return ['', ''];
}

const partOf = (f: () => unknown): [string, string] => {
  try {
    f();
  } catch (e) {
    if (e instanceof FinalityStateError) {
      const p = e.fields.part;
      return [typeof p === 'string' ? p : `<${e.code}>`, e.fields.reason === undefined ? '' : String(e.fields.reason)];
    }
    throw e;
  }
  return ['', ''];
};

function cutEvidence(mode: 'calldata' | 'none' | 'blobs'): Evidence {
  const e: Evidence = {
    lc: {
      profile: ProfileLC,
      anchorKind: 1,
      anchorPeriod: 5n,
      anchorRoot: new Uint8Array(32),
      anchorBody: { layout: Layout.None, ssz: Uint8Array.of(1, 2) },
      links: [
        { layout: Layout.Gloas, ssz: Uint8Array.of(3, 3) },
        { layout: Layout.Gloas, ssz: Uint8Array.of(4) },
      ],
      finalUpdate: { layout: Layout.Gloas, ssz: Uint8Array.of(5, 5, 5) },
    },
    l1Spine: [Uint8Array.of(1, 2, 3), Uint8Array.of(4)],
    stateBlock: 7n,
    blockTxs: [Uint8Array.of(5), Uint8Array.of(6, 6)],
    batchSeq: 8n,
    header40: [1n, 2n, 3n, 4n, 5n],
    beforeAcc: new Uint8Array(32),
    delayedAcc: new Uint8Array(32),
    dataKind: DataNone,
    versionedHashes: [],
    blobs: [],
    calldata: new Uint8Array(0),
    delayed: null,
    nodes: [Uint8Array.of(0xc0), Uint8Array.of(0xc1, 0x80), Uint8Array.of(0xc2, 0x80, 0x80)],
  };
  if (mode === 'calldata') {
    e.dataKind = DataCalldata;
    e.calldata = Uint8Array.of(9, 9, 9);
    e.delayed = { msgKind: 12, sender: new Uint8Array(20), msgBlockNumber: 0n, msgTimestamp: 0n, baseFeeL1: new Uint8Array(32), data: Uint8Array.of(1, 2), k: 3n };
  } else if (mode === 'blobs') {
    e.dataKind = DataBlobs;
    e.versionedHashes = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)];
    e.blobs = [0, 1].map(() => ({ raw: new Uint8Array(BLOB_BYTES), commitment: new Uint8Array(48), proof: new Uint8Array(48) }));
  }
  return e;
}

const bounds = defaultBounds(defaultLimits());

describe('a cut at any byte is refused by the field it falls in (grammar of V2_SPEC_S7 3.3)', () => {
  for (const mode of ['calldata', 'none', 'blobs'] as const) {
    it(`${mode}: the grammar walk covers the whole encoding and every cut names the part and reason the grammar says`, () => {
      const e = cutEvidence(mode);
      const body = encodeEvidence(e);
      const fields = cutFields(e);
      expect(fields.reduce((n, f) => n + size(f), 0)).toBe(body.length);
      const cuts: number[] = [];
      if (mode === 'blobs') {
        // the two 128 KiB blobs: every cut near a field boundary, and a seeded sample of the interior
        let pos = 0;
        for (const f of fields) {
          for (let d = -3; d <= 3; d++) if (pos + d >= 0 && pos + d < body.length) cuts.push(pos + d);
          pos += size(f);
        }
        let x = 13;
        for (let i = 0; i < 40; i++) {
          x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
          cuts.push(x % body.length);
        }
      } else {
        for (let i = 0; i < body.length; i++) cuts.push(i);
      }
      for (const c of cuts) {
        const got = partOf(() => decodeEvidence(body.subarray(0, c), bounds));
        const want = wantPart(fields, c);
        expect(got, `${mode}: a body cut to ${c} of ${body.length} bytes`).toEqual(want);
      }
      expect(() => decodeEvidence(body, bounds)).not.toThrow();
    }, 300_000);
  }
});

describe('a blob whose length prefix is not the blob size is refused in its own part', () => {
  it('4 GiB and one over are too large (the bound), one under and zero are truncated', () => {
    const e = cutEvidence('blobs');
    e.blobs = e.blobs.slice(0, 1);
    e.versionedHashes = e.versionedHashes.slice(0, 1);
    const body = encodeEvidence(e);
    let pos = 0;
    for (const f of cutFields(e)) {
      if (f.name === 'blobs.raw') break;
      pos += size(f);
    }
    const cases: Record<string, [number, string, string]> = {
      '4 GiB': [0xffffffff, 'finality_evidence_too_large', ''],
      'one over': [BLOB_BYTES + 1, 'finality_evidence_too_large', ''],
      'one under': [BLOB_BYTES - 1, 'finality_evidence_malformed', 'truncated'],
      zero: [0, 'finality_evidence_malformed', 'truncated'],
    };
    for (const [name, [sz, code, reason]] of Object.entries(cases)) {
      const mut = Uint8Array.from(body);
      new DataView(mut.buffer).setUint32(pos, sz, false);
      let err: FinalityStateError | undefined;
      try {
        decodeEvidence(mut, bounds);
      } catch (x) {
        if (x instanceof FinalityStateError) err = x;
        else throw x;
      }
      expect(err?.code, name).toBe(code);
      expect(err?.fields.part, name).toBe('blobs.raw');
      expect(err?.fields.reason === undefined ? '' : String(err.fields.reason), name).toBe(reason);
    }
  });
});
