import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readS3, sha256hex } from './helpers/s3.js';
import type { BytesFile } from './helpers/s3-bytes.js';

/**
 * What the Go-written byte-level corpus (go-written/bytes-cases.json.gz, written by `xtsgen bytes`, gen/xtsgen-bytes.go.txt; every verdict
 * is the validator's json.Unmarshal into Portable followed by VerifyPortable on the exact bytes) covers, pinned so that the corpus cannot
 * shrink or lose a defect class unnoticed. The four s3-bytes-N shards judge every case; this file judges the corpus itself.
 *
 *   D1 number literals and duplicate / repeated keys on the text: ops num:*, numstring, dup*, twodocs, bom, whitespace, trailing, truncate,
 *      and the named repros (block=float ... anchor number="1", version dup ..., hash dup null after);
 *   D2 evidence 2.0 refusing 2.1 members, case-insensitively and by type: the "20 ..." repros (both 2.0 fixtures are bases);
 *   D3 key matching by simple case folding (long s, Kelvin): op keyfold and the "roles fold long s" repros;
 *   D4 merkleState.count: op count and the "rootProof count ..." repros;
 *   D5 genesis and set-check JSON read strictly: op hexstring, newline, numstring and the "genesis ..." repros;
 *   D6 invalid UTF-8 and lone surrogates: op utf8 and the "utf8 in a partition" / "surrogate in a partition" repros.
 *
 * D7 (a document naming no usable major block) has no Go verdict - the validator panics there - and is tested in s3-majors-refusal.test.ts;
 * D8 is the regeneration command in gen/xtsgen-main.go.txt.
 */
const raw = readS3('go-written/bytes-cases.json.gz');
const file = JSON.parse(gunzipSync(raw).toString('utf8')) as BytesFile;
const parts = (op: string): string[] => op.split(' + ');
const withOp = (re: RegExp) => file.cases.filter((c) => parts(c.op).some((p) => re.test(p)));
const repro = (re: RegExp) => file.cases.filter((c) => c.op === 'repro' && re.test(c.id));

describe('the Go-written byte-level corpus covers D1 to D6', () => {
  it('has more than 1,000 cases over the 140 base documents, all three kinds of Go verdict, and the 2.0 fixtures among the bases', () => {
    expect(sha256hex(raw)).toBe('2eb7fea1f157a8e812d4e25f68d0d930fe9178102eb65a51a042b1a3e65e2412');
    expect(file.cases.length).toBeGreaterThan(1000);
    expect(file.bases.length).toBe(140);
    expect(file.bases).toEqual(expect.arrayContaining(['proofv2/valid.json.gz', 'proofv2/network-update.json.gz']));
    const kinds = new Set(file.cases.map((c) => c.expect.v));
    expect([...kinds].sort()).toEqual(['named', 'plain', 'verified']);
    for (const v of kinds) expect(file.cases.filter((c) => c.expect.v === v).length).toBeGreaterThan(100);
  });

  it('D1: number literals, repeated keys and the shape of the text', () => {
    expect(withOp(/^num:/).length).toBeGreaterThan(150);
    expect(withOp(/^numstring$/).length).toBeGreaterThan(80);
    for (const op of [/^dupsame$/, /^dupbefore$/, /^dupafter$/, /^dupcase$/, /^twodocs$/, /^bom$/, /^whitespace$/, /^trailing$/, /^truncate$/]) expect(withOp(op).length, String(op)).toBeGreaterThan(5);
    for (const name of ['block=float', 'block=exp', 'block=2^64', 'block=2^53+1', 'majors=1.0', 'anchor number=1e0', 'majors=-0', 'majors="1"', 'version dup number first', 'version dup null after', 'hash dup null after', 'secondaryHash fold null after']) {
      expect(repro(new RegExp(`^repro:${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)).length, name).toBe(1);
    }
  });

  it('D2: evidence 2.0 carrying 2.1 members, exact-case and case-variant, well and wrongly typed', () => {
    expect(repro(/^repro:20 /).length).toBeGreaterThanOrEqual(23);
    for (const name of ['20 Anchors', '20 VOTES', '20 Routing', '20 page Partition', '20 page ROLES', '20 page partition number', '20 page history number', '20 transaction number']) expect(repro(new RegExp(`^repro:${name}$`)).length, name).toBe(1);
  });

  it('D3: key matching by simple case folding', () => {
    expect(withOp(/^keyfold$/).length).toBeGreaterThan(100);
    expect(repro(/^repro:roles fold long s/).length).toBe(2);
  });

  it('D4: merkleState.count', () => {
    expect(withOp(/^count$/).length).toBeGreaterThan(50);
    expect(repro(/^repro:rootProof count/).length).toBe(3);
  });

  it('D5: genesis and set-check JSON read strictly', () => {
    expect(withOp(/^hexstring$/).length).toBeGreaterThan(100);
    expect(withOp(/^newline$/).length).toBeGreaterThan(5);
    expect(repro(/^repro:genesis /).length).toBeGreaterThanOrEqual(5);
  });

  it('D6: invalid UTF-8 and lone surrogates', () => {
    expect(withOp(/^utf8$/).length).toBeGreaterThan(100);
    expect(repro(/^repro:(utf8|surrogate) in a partition/).length).toBe(3);
  });
});
