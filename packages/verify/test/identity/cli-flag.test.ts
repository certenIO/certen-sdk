// WP-S8-CLI (TypeScript half, Part A): the pure layer of `--contract-identity`. Freeze item 6 maps the six headline rows of the contract-identity verifier
// to one line of text and one exit code, byte for byte what cmd/proofverify/contract_identity.go prints, and verified_core is never printed as, counted as
// or exit-coded as verified. The table, the combined exit, the member parser (strict, bounded before decoding) and the judge are the twin of the Go file;
// every vector of the published sets is run through the real verifier and the judge.
import { describe, expect, it } from 'vitest';
import { identity } from '../../src/index.js';
import { readHeader } from '../../src/proof-v2/finality/rlpheader.js';
import { SET_NAMES, setFiles, vectorIds } from './fixtures.js';

const td = new TextDecoder();
const N = identity.names;
const { renderContractIdentity, combineExit, judgeContractIdentity, digestOf, stateText, CI_MEMBER_FORMAT, MAX_CONTAINER_BYTES } = identity;
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const st = (code: string, fields: Record<string, string>): identity.StateError => new identity.StateError(code, fields);

describe('the six headline rows (Freeze item 6)', () => {
  const s6 = st(N.CodeNotChecked, { part: 's6_link', reason: 's6_not_proven', state: 's6_replay_unproven{reason=state_unavailable}' });
  const mismatch = identity.must(N.CodeBlockMismatch, '', { field: 'hash', want: '0x01', got: '0x02' });
  const cases: { name: string; h: identity.Headline; line: string; exit: number }[] = [
    { name: 'verified', h: { kind: N.HeadlineVerified, parts: [], judgedAtLevel: 'finalized', registryLink: 'registry9' }, line: 'contract identity: VERIFIED at finalized (registry registry9)', exit: 0 },
    { name: 'not_applicable', h: { kind: N.HeadlineNotApplicable, parts: [], notApplicable: st(N.CodeNotApplicable, { reason: 'certen_infrastructure' }) }, line: 'contract identity: not applicable (certen_infrastructure)', exit: 5 },
    {
      name: 'verified_core',
      h: { kind: N.HeadlineVerifiedCore, parts: [], open: [{ part: N.JudgedS6Link, kind: 'not_checked', state: s6 }, { part: N.JudgedRegistryLink, kind: 'not_checked', state: st(N.CodeNotChecked, { reason: 'no_registry_in_file' }) }] },
      line: 'contract identity: verified core, 2 open: s6_link:s6_not_proven(s6_replay_unproven{reason=state_unavailable}), registry_link:no_registry_in_file',
      exit: 10,
    },
    { name: 'pending', h: { kind: N.HeadlinePending, parts: [], findings: [{ part: N.JudgedRecord, state: undefined }, { part: N.JudgedPointer, state: undefined }] }, line: 'contract identity: PENDING (state root not authenticated; 2 findings)', exit: 20 },
    { name: 'unproven', h: { kind: N.HeadlineUnproven, parts: ['code_identity', 'record'] }, line: 'contract identity: UNPROVEN: code_identity, record', exit: 30 },
    { name: 'refused', h: { kind: N.HeadlineRefused, parts: [], first: mismatch }, line: 'contract identity: REFUSED: contract_identity_block_mismatch{field="hash",got="0x02",want="0x01"}', exit: 40 },
  ];

  it('prints the text and exit code of the Go table, each exit code once', () => {
    const seen = new Map<number, string>();
    for (const c of cases) {
      const r = renderContractIdentity(c.h);
      expect(r.line, c.name).toBe(c.line);
      expect(r.exit, c.name).toBe(c.exit);
      expect(seen.has(r.exit), `${c.name} shares exit ${r.exit} with ${seen.get(r.exit)}`).toBe(false);
      seen.set(r.exit, c.name);
      // the hard rule: only verified is exit 0 and only verified says VERIFIED
      expect(r.exit === 0, c.name).toBe(c.h.kind === N.HeadlineVerified);
      expect(r.line.includes('VERIFIED'), c.name).toBe(c.h.kind === N.HeadlineVerified);
    }
    expect(stateText(mismatch)).toBe('contract_identity_block_mismatch{field="hash",got="0x02",want="0x01"}');
  });

  it('renders nothing for a headline that does not carry what its row prints', () => {
    expect(() => renderContractIdentity({ kind: 'verified_ish', parts: [] })).toThrow();
    expect(() => renderContractIdentity({ kind: N.HeadlineVerified, parts: [] })).toThrow();
    expect(() => renderContractIdentity({ kind: N.HeadlineVerifiedCore, parts: [], open: [] })).toThrow();
    expect(() => renderContractIdentity({ kind: N.HeadlineUnproven, parts: [] })).toThrow();
    expect(() => renderContractIdentity({ kind: N.HeadlineRefused, parts: [] })).toThrow();
    expect(() => renderContractIdentity({ kind: N.HeadlineNotApplicable, parts: [] })).toThrow();
  });

  it('combines the exit codes: S7 FAILED wins, then a non-zero S8 code, then the S7 code', () => {
    for (const [s7, s8, want] of [[0, 0, 0], [0, 10, 10], [0, 40, 40], [3, 0, 3], [3, 20, 20], [1, 0, 1], [1, 40, 1], [1, 2, 1], [0, 2, 2]] as const) {
      expect(combineExit(s7, s8), `S7 ${s7} S8 ${s8}`).toBe(want);
    }
  });
});

interface Leg { ctx: identity.LegContext; container: Uint8Array | undefined; manifest: identity.Manifest; expected: identity.Expected; id: string }

function legs(): Leg[] {
  const out: Leg[] = [];
  for (const set of SET_NAMES) {
    const files = setFiles(set);
    for (const id of vectorIds(files)) {
      const inputs = identity.loadMaterialised(td.decode(files.get(`${id}.inputs.json`)), files);
      const r = identity.resolveManifest(inputs);
      if (r.refusal || !r.manifest) continue;
      out.push({ ctx: inputs.ctx, container: inputs.container, manifest: r.manifest, expected: JSON.parse(td.decode(files.get(`${id}.expected.json`))) as identity.Expected, id: `${set}/${id}` });
    }
  }
  return out;
}

const blockNumber = (ctx: identity.LegContext): bigint | undefined => {
  if (!ctx.settlement || ctx.settlement.header.length === 0) return undefined;
  try { return readHeader(ctx.settlement.header).number; } catch { return undefined; }
};

function memberFor(ctx: identity.LegContext, container: Uint8Array): string {
  const n = blockNumber(ctx)!;
  const d = digestOf(ctx.chain, n, ctx.settlement!.blockHash, container);
  return JSON.stringify({ format: CI_MEMBER_FORMAT, leg: { chain: Number(ctx.chain), blockNumber: Number(n), blockHash: '0x' + hex(ctx.settlement!.blockHash) }, evidence: '0x' + hex(container), digest: '0x' + hex(d) });
}

const EXIT_OF: Record<string, number> = { verified: 0, not_applicable: 5, verified_core: 10, pending: 20, unproven: 30, refused: 40 };
const all = legs();
const eligible = all.filter((l) => l.container && l.container.length > 0 && blockNumber(l.ctx) !== undefined);

describe('the real verifier over the published vector sets, through the judge', () => {
  it('maps every vector to the exit code of its expected headline and never prints verified_core as verified', { timeout: 900_000 }, () => {
    const kinds = new Map<string, number>();
    for (const l of eligible) {
      const r = judgeContractIdentity(memberFor(l.ctx, l.container!), l.ctx, (c) => identity.productionVerifier()(l.ctx, c, l.manifest));
      expect(r.exit, `${l.id}: ${r.text}`).toBe(EXIT_OF[l.expected.headline]);
      expect(r.text.startsWith('contract identity: '), l.id).toBe(true);
      expect(r.text.endsWith('\n') && r.text.indexOf('\n') === r.text.length - 1, `${l.id}: one line`).toBe(true);
      if (l.expected.headline === 'verified_core') {
        expect(r.exit, l.id).not.toBe(0);
        expect(r.text, l.id).not.toContain('VERIFIED');
        expect(r.text, l.id).toMatch(/^contract identity: verified core, [1-9][0-9]* open: \S.*\n$/);
      }
      if (l.expected.headline === 'verified') expect(r.text, l.id).toMatch(/^contract identity: VERIFIED at \S+ \(registry \S.*\)\n$/);
      if (l.expected.headline === 'pending') expect(r.text, l.id).toMatch(/^contract identity: PENDING \(state root not authenticated; [0-9]+ findings\)\n$/);
      if (l.expected.headline === 'refused') expect(r.text, l.id).toMatch(/^contract identity: REFUSED: contract_identity_[a-z0-9_]+\{/);
      kinds.set(l.expected.headline, (kinds.get(l.expected.headline) ?? 0) + 1);
    }
    expect(eligible.length, 'vectors run').toBeGreaterThanOrEqual(150);
    for (const k of ['verified_core', 'refused', 'unproven', 'pending', 'verified']) expect(kinds.get(k) ?? 0, `no published vector with headline ${k} was run`).toBeGreaterThan(0);
  });

  it('judges an absent member as unproven{all} (exit 30), whatever its spelling', () => {
    const l = eligible.find((x) => x.expected.headline === 'verified')!;
    for (const absent of [undefined, null, 'null', '  null\n']) {
      const r = judgeContractIdentity(absent, l.ctx, (c) => identity.productionVerifier()(l.ctx, c, l.manifest));
      expect(r.exit).toBe(30);
      expect(r.text).toBe('contract identity: UNPROVEN: all\n');
    }
  });
});

describe('hostile members are refused or an error by name, and the verifier is not reached', () => {
  const base = eligible[0]!;
  const ctx = base.ctx;
  const n = blockNumber(ctx)!;
  const chainS = ctx.chain.toString();
  const hashHex = hex(ctx.settlement!.blockHash);
  const legJson = `{"chain":${chainS},"blockNumber":${n},"blockHash":"0x${hashHex}"}`;
  const container = new TextEncoder().encode('CIE1-test-vector');
  const ev = '0x' + hex(container);
  const dg = '0x' + hex(digestOf(ctx.chain, n, ctx.settlement!.blockHash, container));
  const mk = (format: string, leg: string, evidence: string, digest: string, extra = ''): string => `{"format":"${format}","leg":${leg},"evidence":"${evidence}","digest":"${digest}"${extra}}`;
  const max = MAX_CONTAINER_BYTES;
  const flip = (h: string): string => (h[0] === '2' ? '3' : '2') + h.slice(1);
  const refused = 'contract identity: REFUSED: ';
  const err = 'proofverify: contractIdentity member';
  const cases: { name: string; member: string; exit: number; text: string }[] = [
    { name: 'wrong version', member: mk('certen-contract-identity/2', legJson, ev, dg), exit: 40, text: refused + 'contract_identity_evidence_unrecognised{' },
    { name: 'wrong family', member: mk('certen-finality-addenda/1', legJson, ev, dg), exit: 40, text: refused + 'contract_identity_evidence_unrecognised{' },
    { name: 'oversize evidence', member: mk(CI_MEMBER_FORMAT, legJson, '0x' + 'ab'.repeat(max + 1), dg), exit: 40, text: refused + stateText(identity.tooLarge('container', max + 1, max)) },
    { name: 'leg chain differs', member: mk(CI_MEMBER_FORMAT, legJson.replace(`"chain":${chainS}`, `"chain":${ctx.chain + 1n}`), ev, dg), exit: 40, text: refused + 'contract_identity_block_mismatch{field="chain"' },
    { name: 'leg number differs', member: mk(CI_MEMBER_FORMAT, legJson.replace(`"blockNumber":${n}`, `"blockNumber":${n + 1n}`), ev, dg), exit: 40, text: refused + 'contract_identity_block_mismatch{field="number"' },
    { name: 'leg hash differs', member: mk(CI_MEMBER_FORMAT, legJson.replace(hashHex, flip(hashHex)), ev, dg), exit: 40, text: refused + 'contract_identity_block_mismatch{field="hash"' },
    { name: 'unknown member field', member: mk(CI_MEMBER_FORMAT, legJson, ev, dg, ',"extra":1'), exit: 2, text: err },
    { name: 'unknown leg field', member: mk(CI_MEMBER_FORMAT, legJson.replace('}', ',"x":1}'), ev, dg), exit: 2, text: err },
    { name: 'duplicate key', member: mk(CI_MEMBER_FORMAT, legJson, ev, dg, `,"digest":"${dg}"`), exit: 2, text: err },
    { name: 'duplicate leg key', member: mk(CI_MEMBER_FORMAT, legJson.replace('}', `,"chain":${chainS}}`), ev, dg), exit: 2, text: err },
    { name: 'evidence without 0x', member: mk(CI_MEMBER_FORMAT, legJson, 'abcd', dg), exit: 2, text: err },
    { name: 'evidence odd length', member: mk(CI_MEMBER_FORMAT, legJson, '0xabc', dg), exit: 2, text: err },
    { name: 'evidence empty', member: mk(CI_MEMBER_FORMAT, legJson, '0x', dg), exit: 2, text: err },
    { name: 'evidence upper-case 0X', member: mk(CI_MEMBER_FORMAT, legJson, '0Xabcd', dg), exit: 2, text: err },
    { name: 'digest wrong', member: mk(CI_MEMBER_FORMAT, legJson, ev, '0x' + '00'.repeat(32)), exit: 2, text: err },
    { name: 'digest short', member: mk(CI_MEMBER_FORMAT, legJson, ev, '0x00'), exit: 2, text: err },
    { name: 'digest missing', member: `{"format":"${CI_MEMBER_FORMAT}","leg":${legJson},"evidence":"${ev}"}`, exit: 2, text: err },
    { name: 'not an object', member: '[1]', exit: 2, text: err },
    { name: 'empty object', member: '{}', exit: 2, text: err },
    { name: 'trailing data', member: mk(CI_MEMBER_FORMAT, legJson, ev, dg) + ' {}', exit: 2, text: err },
    { name: 'leg block number as string', member: mk(CI_MEMBER_FORMAT, legJson.replace(`"blockNumber":${n}`, `"blockNumber":"${n}"`), ev, dg), exit: 2, text: err },
    { name: 'leg block number with a fraction', member: mk(CI_MEMBER_FORMAT, legJson.replace(`"blockNumber":${n}`, `"blockNumber":${n}.0`), ev, dg), exit: 2, text: err },
    { name: 'leg block number negative', member: mk(CI_MEMBER_FORMAT, legJson.replace(`"blockNumber":${n}`, `"blockNumber":-1`), ev, dg), exit: 2, text: err },
    { name: 'format is not a string', member: `{"format":1,"leg":${legJson},"evidence":"${ev}","digest":"${dg}"}`, exit: 2, text: err },
    { name: 'format is empty', member: mk('', legJson, ev, dg), exit: 2, text: err },
    { name: 'format is not printable ASCII', member: mk('certen-é/1', legJson, ev, dg), exit: 2, text: err },
  ];

  it('never reaches the verifier with a member that cannot form a container, and never exits 0', () => {
    let reached = 0;
    const trap = (): identity.Report => { reached++; throw new Error('the verifier must not be reached'); };
    for (const c of cases) {
      const r = judgeContractIdentity(c.member, ctx, trap);
      expect(r.exit, `${c.name}: ${r.text}`).toBe(c.exit);
      expect(r.text.startsWith(c.text), `${c.name}: ${r.text.slice(0, 200)}`).toBe(true);
      expect(r.exit, `${c.name}: a hostile member exited 0`).not.toBe(0);
    }
    expect(reached).toBe(0);
  });

  it('bounds the container exactly: MaxContainerBytes reaches the verifier, one more does not', () => {
    let reached = 0;
    const trap = (): identity.Report => { reached++; throw new Error('trap'); };
    const exact = new Uint8Array(max).fill(0xab);
    const d = digestOf(ctx.chain, n, ctx.settlement!.blockHash, exact);
    const r = judgeContractIdentity(mk(CI_MEMBER_FORMAT, legJson, '0x' + hex(exact), '0x' + hex(d)), ctx, trap);
    expect(r.exit).toBe(2);
    expect(reached).toBe(1);
    expect(r.text.startsWith('proofverify: contract identity verifier')).toBe(true);
    // a hex text one byte over the bound is refused from its length, before any byte is decoded
    expect(judgeContractIdentity(mk(CI_MEMBER_FORMAT, legJson, '0x' + 'ab'.repeat(max) + 'a', dg), ctx, trap).exit).toBe(40);
    expect(reached).toBe(1);
  });

  it('reads a container that is judged, not parsed: a valid member reaches the verifier with its bytes', () => {
    let got: Uint8Array | undefined;
    const r = judgeContractIdentity(mk(CI_MEMBER_FORMAT, legJson, ev, dg), ctx, (c) => { got = c; throw new Error('stop'); });
    expect(r.exit).toBe(2);
    expect(got && hex(got)).toBe(hex(container));
  });

  it('a verifier error, a thrown non-error and an empty report are exit 2 with no report line', () => {
    const member = mk(CI_MEMBER_FORMAT, legJson, ev, dg);
    for (const [name, v] of [
      ['error', (): identity.Report => { throw new Error('boom'); }],
      ['thrown string', (): identity.Report => { throw 'boom'; }],
      ['empty report', (): identity.Report => ({ headline: { kind: '', parts: [] } }) as unknown as identity.Report],
    ] as const) {
      const r = judgeContractIdentity(member, ctx, v);
      expect(r.exit, name).toBe(2);
      expect(r.text.startsWith('proofverify: '), name).toBe(true);
      expect(r.text, name).not.toContain('contract identity:');
    }
  });
});
