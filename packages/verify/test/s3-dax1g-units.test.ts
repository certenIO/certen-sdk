import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkClosureBudget, checkClosureBudgetInitiating, evidenceJson, INITIATING_SIGNATURE_PROOF_BYTES, MAX_EVIDENCE_BYTES, FIXED_EVIDENCE_BYTES, pageJson } from '../src/s3/budget.js';
import { decodeEvidenceFull, evidence20View, EVIDENCE_FIELDS, judgeProofV2, marshalEvidence, unmarshalCertifiedEvidence, VIEW_KEPT, withoutInitiatingSignature, IntentProofError, type EvidenceVal } from '../src/s3/consensus.js';
import { importEvidence, type Hop, type PageState } from '../src/s3/evidence.js';
import { decodePortable } from '../src/s3/gotree.js';
import { keyHeldDuring, States } from '../src/s3/govvote.js';
import { AccUrl } from '../src/s3/acc.js';
import { KeyPage, TransactionType } from '../src/s3/model.js';
import { NamedState } from '../src/s3/states.js';
import { sha256 } from '../src/proof-v2/bytes.js';

/**
 * The pieces of the DAX-1G member the shared vectors do not reach: the one rule of "the page held the key" (govvote.KeyHeldDuring), the evidence form consensus
 * carries (certificate decode, the 2.0 view, the rules-v16 gate of judgeProofV2) and the budget (the member counts in the document's size and in the capture's).
 * Each is the TypeScript twin of a Go test or of the Go function named in its comment.
 */
const vectorText = (name: string): string => readFileSync(new URL(`./fixtures/s3-dax1g/xpartition7/${name}.json`, import.meta.url), 'utf8');

// ---------------------------------------------------------------------------------------------------------------------------------------
// govvote.KeyHeldDuring (model_test.go TestKeyHeldDuring)

const keyOf = (name: string): Uint8Array => sha256(new TextEncoder().encode(name));
const sortedKeys = (names: string[]): { publicKeyHash: Uint8Array; lastUsedOn: bigint; delegate: null }[] =>
  names
    .map((n) => ({ publicKeyHash: keyOf(n), lastUsedOn: 0n, delegate: null }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.publicKeyHash), Buffer.from(b.publicKeyHash)));
const page = (version: bigint, keys: string[], blacklist: bigint | null = null): KeyPage =>
  new KeyPage(new AccUrl('erp.acme', '/book/1'), version, 1n, 0n, 0n, 0n, sortedKeys(keys), blacklist);

describe('keyHeldDuring: the one rule of "the page could have accepted this key"', () => {
  // version 1 from block 1 holding {a}; version 2 from block 50 holding {a, b} and blacklisting UpdateKeyPage (bit 1)
  const tl = new States([
    { block: 1, page: page(1n, ['a']) },
    { block: 50, page: page(2n, ['a', 'b'], 1n << 1n) },
  ]);
  const cases: [string, number, bigint, number, string, number, number][] = [
    ['held at version 1', TransactionType.UpdateAccountAuth, 1n, 10, 'a', 1, 1],
    ['a key never on the page', TransactionType.UpdateAccountAuth, 1n, 10, 'z', 0, 1],
    ['b is added at version 2, not before', TransactionType.UpdateAccountAuth, 1n, 10, 'b', 0, 1],
    ['held at version 2', TransactionType.UpdateAccountAuth, 2n, 60, 'b', 1, 1],
    ['a type the page blacklists', TransactionType.UpdateKeyPage, 2n, 60, 'a', 0, 1],
    ['a type the page allows', TransactionType.UpdateAccountAuth, 2n, 60, 'a', 1, 1],
    ['the version the page did not hold in that block', TransactionType.UpdateAccountAuth, 2n, 10, 'a', 0, 0],
  ];
  for (const [name, typ, version, block, key, holding, candidates] of cases) {
    it(name, () => {
      expect(keyHeldDuring(tl, typ, version, block, keyOf(key))).toEqual({ holding, candidates });
    });
  }
  it('a state that began in the block is a candidate beside the one the page entered the block in: a key removed in the block is held by the state the page entered it in', () => {
    const t2 = new States([
      { block: 1, page: page(1n, ['a', 'b']) },
      { block: 20, page: page(1n, ['a']) },
    ]);
    expect(keyHeldDuring(t2, TransactionType.UpdateAccountAuth, 1n, 19, keyOf('b'))).toEqual({ holding: 1, candidates: 1 });
    expect(keyHeldDuring(t2, TransactionType.UpdateAccountAuth, 1n, 20, keyOf('b'))).toEqual({ holding: 1, candidates: 2 });
    expect(keyHeldDuring(t2, TransactionType.UpdateAccountAuth, 1n, 21, keyOf('b'))).toEqual({ holding: 0, candidates: 1 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// the evidence form consensus carries

function goForm(name: string): { text: string; ev: ReturnType<typeof importEvidence> } {
  const ev = importEvidence(decodePortable(vectorText(name)));
  return { text: evidenceJson(ev), ev };
}

describe('the certificate decode keeps, copies and views the member as Go does', () => {
  const { text, ev } = goForm('initiator-nonvoting-carried');

  it('json.Marshal of the imported evidence writes the member between genesisLink and check, as the Go struct orders them', () => {
    expect(ev.initiatingSignature).toBeDefined();
    expect(text).toContain('"genesisLink":"');
    const g = text.indexOf('"genesisLink":');
    const m = text.indexOf(',"initiatingSignature":{"page":"acc://pv2-erp-5.acme/book/1"');
    const c = text.indexOf(',"check":{');
    expect(g).toBeGreaterThan(0);
    expect(m).toBeGreaterThan(g);
    expect(c).toBeGreaterThan(m);
    // and no other member sits between them
    expect(text.slice(g, m).match(/"[a-zA-Z]+":/g)!.length).toBe(1);
  });

  it('a document without the member is written without it (omitempty): the member costs exactly its own bytes', () => {
    const without = evidenceJson({ ...ev, initiatingSignature: undefined });
    expect(without).not.toContain('initiatingSignature');
    const member = text.slice(text.indexOf(',"initiatingSignature":'), text.indexOf(',"check":{'));
    expect(without.length + member.length).toBe(text.length);
  });

  it('a document that claims 2.1 is decoded completely: the member survives a decode and re-encode byte for byte, with the links Go carries beside it', () => {
    const full = decodeEvidenceFull(text);
    expect(full.InitiatingSignature).not.toBeNull();
    expect((full.InitiatingSignature as { Page: string }).Page).toBe('acc://pv2-erp-5.acme/book/1');
    expect(typeof full.GenesisLink).toBe('string');
    expect(full.GenesisLink).not.toBe('');
    expect(marshalEvidence(full)).toBe(text);
    const cert = unmarshalCertifiedEvidence(text)!;
    expect(cert.InitiatingSignature).not.toBeNull();
    expect(marshalEvidence(cert)).toBe(text);
  });

  it('a document that claims 2.0 is decoded into the members v14 kept: the member (and the other 2.1 members) are dropped whatever their type', () => {
    const as20 = text.replace('"version":"2.1"', '"version":"2.0"');
    expect(as20).not.toBe(text);
    const cert = unmarshalCertifiedEvidence(as20)!;
    expect(cert.InitiatingSignature).toBeNull();
    expect(cert.GenesisLink).toBe('');
    expect(marshalEvidence(cert)).not.toContain('initiatingSignature');
    // even a member of the wrong type is ignored for a 2.0 claim
    const wrong = as20.replace(',"initiatingSignature":{', ',"initiatingSignature":7,"x":{');
    expect(wrong).not.toBe(as20);
    expect(unmarshalCertifiedEvidence(wrong)!.InitiatingSignature).toBeNull();
  });

  it('the 2.0 view clears the member, and every field of the form is classified as kept or as a 2.1-only member (TestEveryEvidenceFieldIsClassifiedForThe20View)', () => {
    const full = decodeEvidenceFull(text);
    expect(evidence20View(full)!.InitiatingSignature).toBeNull();
    const only21 = ['Anchors', 'GenesisLink', 'InitiatingSignature', 'Links', 'Transaction', 'Votes'];
    expect([...EVIDENCE_FIELDS].sort()).toEqual([...VIEW_KEPT.evidence, ...only21].sort());
    for (const f of only21) expect(VIEW_KEPT.evidence as readonly string[]).not.toContain(f);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// the rules-v16 gate (intent_certificate.go withoutInitiatingSignature, judgeProofV2; consensus g1_activation_member_test.go
// TestEvidenceIsJudgedWithoutTheMemberUntilItsActivation)

describe('the evidence is judged without the member until its activation', () => {
  const full = decodeEvidenceFull(goForm('initiator-nonvoting-carried').text);
  const stop = 'the verifier saw the document';

  it('withoutInitiatingSignature copies the document and clears the member; a document without it is returned as it is', () => {
    const got = withoutInitiatingSignature(full);
    expect(got).not.toBe(full);
    expect(got.InitiatingSignature).toBeNull();
    expect(got.Account).toBe(full.Account);
    expect(full.InitiatingSignature).not.toBeNull();
    const none = { ...full, InitiatingSignature: null } as EvidenceVal;
    expect(withoutInitiatingSignature(none)).toBe(none);
  });

  const judge = (memberInForce: boolean | undefined, activationRequired = true): { seen: EvidenceVal | undefined; err: unknown } => {
    let seen: EvidenceVal | undefined;
    let err: unknown;
    try {
      judgeProofV2({
        proofV2: full,
        activationRequired,
        ...(memberInForce === undefined ? {} : { memberInForce }),
        verify: (doc) => {
          seen = doc;
          throw new Error(stop);
        },
        accRoot: '',
        root: () => '',
      });
    } catch (e) {
      err = e;
    }
    return { seen, err };
  };

  for (const [name, inForce, want] of [
    ['2.1 in force, the member not', false, false],
    ['2.1 in force, the member not (the input absent: v15 behaviour)', undefined, false],
    ['2.1 and the member in force', true, true],
  ] as [string, boolean | undefined, boolean][]) {
    it(name, () => {
      const { seen, err } = judge(inForce);
      expect(err).toBeInstanceOf(IntentProofError);
      expect((err as IntentProofError).kind).toBe('ErrIntentProofV2Invalid');
      expect((err as Error).message).toContain(stop);
      expect(seen!.InitiatingSignature !== null, 'the member reaches the verifier').toBe(want);
      expect(full.InitiatingSignature, "the certificate's own document is never edited").not.toBeNull();
    });
  }

  it('the gate does not change which activation-vs-version refusal consensus gives', () => {
    const { err } = judge(true, false);
    expect((err as IntentProofError).kind).toBe('ErrIntentProofV21NotInForce');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// the budget (xbudget.go CheckClosureBudgetInitiating, CheckEvidenceBudget)

describe('the member counts in the budget', () => {
  const hop = { page: 'acc://erp.acme/book/1', message: 'ab'.repeat(32), signature: 'cd'.repeat(100), block: 64, receipt: { start: new Uint8Array(0), anchor: new Uint8Array(0), entries: [], bin: new Uint8Array(0) } } as unknown as Hop;
  const hopLen = JSON.stringify({ page: hop.page, message: hop.message, signature: hop.signature, block: hop.block, receipt: '' }).length;
  const mkPage = (n: number, pad: number): PageState =>
    ({ url: 'acc://x.acme/p', state: new Uint8Array(n), receipt: { bin: new Uint8Array(0) }, chains: [], pendingHash: 'p'.repeat(pad), chainError: '', partition: '', roles: undefined, history: undefined, chainsJson: undefined }) as unknown as PageState;
  const sized = (target: number): PageState[] => {
    // pages whose encoding plus the fixed part and the (empty) votes is exactly `target`
    const base = FIXED_EVIDENCE_BYTES + 'null'.length;
    const empty = Buffer.byteLength(pageJson(mkPage(0, 1)), 'utf8');
    const need = target - base - empty; // bytes of state, as hex (2 per byte), plus padding to fix the parity
    const n = Math.floor(need / 2);
    const pad = 1 + (need - 2 * n);
    const p = mkPage(n, pad);
    expect(base + Buffer.byteLength(pageJson(p), 'utf8')).toBe(target);
    return [p];
  };
  const code = (f: () => void): string | undefined => {
    try {
      f();
    } catch (e) {
      return e instanceof NamedState ? e.code : `plain: ${(e as Error).message}`;
    }
    return undefined;
  };

  it('the capture adds the captured hop and the proof the assembler builds: exactly hop + 6000 bytes', () => {
    expect(INITIATING_SIGNATURE_PROOF_BYTES).toBe(6_000);
    const add = hopLen + INITIATING_SIGNATURE_PROOF_BYTES;
    // the closure is exactly at the limit with the member: fits; one byte more: refused by name
    expect(code(() => checkClosureBudgetInitiating('2.1', sized(MAX_EVIDENCE_BYTES - add), [], hop, 'BVN1', 5))).toBeUndefined();
    expect(code(() => checkClosureBudgetInitiating('2.1', sized(MAX_EVIDENCE_BYTES - add + 1), [], hop, 'BVN1', 5))).toBe('g1_closure_exceeds_budget');
  });

  it('a closure that fits only without the member is refused with it, and no member is checkClosureBudget exactly', () => {
    const pages = sized(MAX_EVIDENCE_BYTES - 100);
    expect(code(() => checkClosureBudgetInitiating('2.1', pages, [], undefined, 'BVN1', 5))).toBeUndefined();
    expect(code(() => checkClosureBudget('2.1', pages, [], 'BVN1', 5))).toBeUndefined();
    expect(code(() => checkClosureBudgetInitiating('2.1', pages, [], hop, 'BVN1', 5))).toBe('g1_closure_exceeds_budget');
    const over = sized(MAX_EVIDENCE_BYTES + 2);
    expect(code(() => checkClosureBudget('2.1', over, [], 'BVN1', 5))).toBe('g1_closure_exceeds_budget');
  });

  it('an unknown evidence version is an error, never a default', () => {
    expect(code(() => checkClosureBudgetInitiating('3.0', [], [], hop, 'BVN1', 5))).toContain('plain: closure budget: unknown evidence version');
  });
});
