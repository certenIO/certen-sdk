import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { NamedState, verifyPortableAnyBytes } from '../src/s3/index.js';
import { summarize, type ReportSummary } from './helpers/s3.js';

/**
 * The rules-v16 member `initiatingSignature` of evidence 2.1, attacked (DAX-1G). Every document here is the Go-written vector initiator-nonvoting-carried (or the
 * 2.0 fixture) with ONE thing changed; the verdict must be a refusal by NAME (the state, the partition and the block it was judged at) or, where the change is
 * invisible to Go, the verdict Go gives. A carried member is proven COMPLETELY or the document is refused: there is no verdict in which it is "carried but partly
 * unproven", and no document with a member that reaches `verified` while the role it carries is not proven.
 */
const dir = new URL('./fixtures/s3-dax1g/xpartition7/', import.meta.url);
type Doc = { evidence: Record<string, any> } & Record<string, any>;
const load = (name: string): Doc => JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8')) as Doc;

type Verdict = { kind: 'verified'; summary: ReportSummary; unproven: string[] } | { kind: 'named'; code: string; partition: string; block: number; message: string } | { kind: 'plain'; message: string };

function judgeText(text: string): Verdict {
  try {
    const out = verifyPortableAnyBytes(text);
    if (out.version !== '2.1') return { kind: 'plain', message: 'not evidence 2.1' };
    const summary = summarize(out.report);
    return { kind: 'verified', summary, unproven: summary.unproven.map((u) => u.code) };
  } catch (e) {
    if (e instanceof NamedState) return { kind: 'named', code: e.code, partition: e.partition, block: e.block, message: e.message };
    return { kind: 'plain', message: e instanceof Error ? e.message : String(e) };
  }
}
const judge = (doc: unknown): Verdict => judgeText(JSON.stringify(doc));

const BVN1 = 12_600_050;
const BVN2 = 12_600_070;
const BVN3 = 12_600_090;
const ERP = 'acc://pv2-erp-5.acme/book/1';

function expectNamed(v: Verdict, code: string, partition: string, block: number, text?: string): void {
  expect(v.kind, v.kind === 'verified' ? 'a refusal was expected, the document verified' : (v as { message?: string }).message).toBe('named');
  if (v.kind !== 'named') return;
  expect({ code: v.code, partition: v.partition, block: v.block }).toEqual({ code, partition, block });
  if (text) expect(v.message).toContain(text);
}
const roleOf = (v: Verdict, url: string): { roles: string[]; declared: string[] } => {
  if (v.kind !== 'verified') throw new Error('not verified');
  const p = v.summary.proven.find((x) => x.url === url)!;
  return { roles: p.roles, declared: p.declared };
};

/** The document text with the member's JSON member replaced by what `f` makes of the member's JSON text (to repeat the key, change its case, ...). */
function spliceMember(doc: Doc, f: (memberJson: string) => string): string {
  const mj = JSON.stringify(doc.evidence.initiatingSignature);
  const text = JSON.stringify(doc);
  const needle = `"initiatingSignature":${mj}`;
  const i = text.indexOf(needle);
  expect(i, 'the member is in the text').toBeGreaterThan(0);
  expect(text.indexOf(needle, i + 1), 'the member is in the text once').toBe(-1);
  return text.slice(0, i) + f(mj) + text.slice(i + needle.length);
}
const flip = (hex: string, at: number): string => hex.slice(0, at) + (hex[at] === '0' ? '1' : '0') + hex.slice(at + 1);

describe('the control: the carried vector', () => {
  it('verifies, and initiator-signer is PROVEN on the payer', () => {
    const v = judge(load('initiator-nonvoting-carried'));
    expect(v.kind).toBe('verified');
    if (v.kind !== 'verified') return;
    expect(v.unproven).toEqual([]);
    expect(roleOf(v, ERP).roles).toContain('initiator-signer');
    expect(roleOf(v, ERP).declared).toEqual(['certified-key-page']);
  });
});

describe('the member is carried but its page is not proven', () => {
  for (const page of ['acc://not-a-proven-page.acme/book/1', 'acc://pv2-erp-5.acme/book/2', '::: not a url :::']) {
    it(`page ${JSON.stringify(page)}`, () => {
      const d = load('initiator-nonvoting-carried');
      d.evidence.initiatingSignature.page = page;
      // judged at the transaction's partition: the page the member names is not among the proven pages, so it has none of its own
      expectNamed(judge(d), 'g1_initiator_page_unproven', 'BVN1', BVN1, 'which is not among the proven pages');
    });
  }
  it('a proven page that is not the one the signature was recorded on is refused by its chain: the message is not a member of its signature chain', () => {
    const d = load('initiator-nonvoting-carried');
    d.evidence.initiatingSignature.page = 'acc://pv2-bank-5.acme/book/1';
    expectNamed(judge(d), 'g1_block_before_signature', 'BVN2', BVN2);
  });
});

describe('the arrival block', () => {
  for (const delta of [1, -1, 100]) {
    it(`a claimed block ${delta > 0 ? '+' : ''}${delta} from the one the signature-index chain gives`, () => {
      const d = load('initiator-nonvoting-carried');
      d.evidence.initiatingSignature.block += delta;
      expectNamed(judge(d), 'g1_arrival_unproven', 'BVN3', BVN3, 'was claimed to arrive in block');
    });
  }
  it('no arrival proof at all (the member REQUIRES it)', () => {
    const d = load('initiator-nonvoting-carried');
    delete d.evidence.initiatingSignature.arrival;
    expectNamed(judge(d), 'g1_arrival_unproven', 'BVN3', BVN3, 'carries no arrival proof');
  });
  it('an arrival whose index entry position is moved', () => {
    const d = load('initiator-nonvoting-carried');
    d.evidence.initiatingSignature.arrival.at.position += 1;
    const v = judge(d);
    expect(v.kind).toBe('named');
    if (v.kind === 'named') expect(v.code).toBe('g1_arrival_unproven');
  });
});

describe('the signature', () => {
  it('one nibble of the signature flipped: it is not the message its chain entry holds', () => {
    const d = load('initiator-nonvoting-carried');
    const m = d.evidence.initiatingSignature;
    m.signature = flip(m.signature, m.signature.length - 3);
    expectNamed(judge(d), 'g1_signature_invalid', 'BVN3', BVN3, 'is not the message its chain entry holds');
  });
  it('one nibble of the message flipped', () => {
    const d = load('initiator-nonvoting-carried');
    const m = d.evidence.initiatingSignature;
    m.message = flip(m.message, 10);
    expectNamed(judge(d), 'g1_signature_invalid', 'BVN3', BVN3, 'is not the message its chain entry holds');
  });
  it('the signature is not hex', () => {
    const d = load('initiator-nonvoting-carried');
    d.evidence.initiatingSignature.signature = 'zz';
    expectNamed(judge(d), 'g1_signature_invalid', 'BVN3', BVN3, 'a signature is not hex');
  });
  it('the signature holds no type (a run of zeros): Accumulate answers neither a signature nor an error', () => {
    const d = load('initiator-nonvoting-carried');
    d.evidence.initiatingSignature.signature = '00000000';
    expectNamed(judge(d), 'g1_signature_invalid', 'BVN3', BVN3);
  });
});

describe('the receipt', () => {
  it('one nibble of a receipt step flipped: the message is not a member of the chain at the block', () => {
    const d = load('initiator-nonvoting-carried');
    const r = d.evidence.initiatingSignature.receipt;
    expect(r.entries.length).toBeGreaterThan(0);
    r.entries[0].hash = flip(r.entries[0].hash, 4);
    expectNamed(judge(d), 'g1_block_before_signature', 'BVN3', BVN3, "is not a member of");
  });
});

describe('the transaction and the roles', () => {
  it('the member is carried but the document carries no transaction', () => {
    const d = load('initiator-nonvoting-carried');
    d.evidence.transaction = '';
    expectNamed(judge(d), 'g1_transaction_mismatch', 'BVN1', BVN1, 'carries an initiating signature but no transaction');
  });
  it('the payer page does not record the role the member justifies', () => {
    const d = load('initiator-nonvoting-carried');
    const p = d.evidence.pages.find((x: { url: string }) => x.url === ERP);
    p.roles = ['certified-key-page'];
    expectNamed(judge(d), 'g1_role_mismatch', 'BVN3', BVN3, 'is justified by the proven states but not recorded');
  });
  it('a page that is not the initiator records the role', () => {
    const d = load('initiator-nonvoting-carried');
    const p = d.evidence.pages.find((x: { url: string }) => x.url === 'acc://pv2-bank-5.acme/book/1');
    p.roles = ['authority-page', 'initiator-signer', 'voter'];
    expectNamed(judge(d), 'g1_role_mismatch', 'BVN2', BVN2, 'is claimed but the proven states do not justify it');
  });
  it('a history carried for the payer page that was edited does not fold to the proven chain root', () => {
    const d = load('initiator-nonvoting-carried');
    const p = d.evidence.pages.find((x: { url: string }) => x.url === ERP);
    expect(p.history.entries.length).toBeGreaterThan(0);
    const t = p.history.entries[0].transaction as string;
    p.history.entries[0].transaction = flip(t, t.length - 5);
    const v = judge(d);
    expect(v.kind, v.kind === 'verified' ? 'verified' : (v as { message?: string }).message).not.toBe('verified');
  });
});

describe('the refusal says what is wrong (steps whose outcome alone cannot tell them apart from the next one)', () => {
  const text = (name: string): Verdict => judge(load(name));
  it('the transaction names no initiator: the member claims a role the transaction does not justify (step 2, before the did-initiate rule of step 5)', () => {
    expectNamed(text('initiator-member-header-names-no-initiator'), 'g1_role_mismatch', 'BVN3', BVN3, 'the transaction names no initiator');
  });
  it('the member is a valid non-initiating signature of the same page: it is not the one the header names (step 5)', () => {
    expectNamed(text('initiator-member-not-the-initiator'), 'g1_role_mismatch', 'BVN3', BVN3, 'is not the one the transaction header names as its initiator');
  });
  it('the member is an authority signature, which cannot initiate (step 3)', () => {
    expectNamed(text('initiator-member-is-an-authority-signature'), 'g1_signature_invalid', 'BVN3', BVN3, 'is an authority signature');
  });
  it('the signature is recorded on another page than the one that made it (step 8)', () => {
    expectNamed(text('initiator-signature-recorded-on-another-page'), 'g1_signature_invalid', 'BVN2', BVN2, 'recorded on');
  });
  it('the chain holds the message of a signature that initiates but signs ANOTHER transaction: the signature check refuses it (step 7)', () => {
    expectNamed(text('initiator-signature-signs-another-transaction'), 'g1_signature_invalid', 'BVN3', BVN3, 'the signature on');
  });
  it('the page carries no certified history: the key cannot be judged against the page as it stood (step 9)', () => {
    expectNamed(text('initiator-member-no-history'), 'g1_history_unavailable', 'BVN3', BVN3, "carried without the page's certified history");
  });
  it('the key was removed before the signature arrived, or the page blacklisted the type: no state of the page at the signer version held it (step 9)', () => {
    expectNamed(text('initiator-key-not-held'), 'g1_initiator_key_not_held', 'BVN3', BVN3, 'both held the key of the initiating signature');
    expectNamed(text('initiator-page-blacklists-the-transaction-type'), 'g1_initiator_key_not_held', 'BVN3', BVN3, 'both held the key of the initiating signature');
  });
  it('a delegator of the signature that is not a proven page is refused at the transaction partition', () => {
    expectNamed(text('initiator-delegator-not-a-proven-page'), 'g1_initiator_page_unproven', 'BVN1', BVN1, 'is not among the proven pages');
  });
  it('a key removed AFTER the signature arrived does not make it unproven: the page held the key when the signature arrived', () => {
    const v = text('initiator-nonvoting-key-removed-after-arrival');
    expect(v.kind).toBe('verified');
    expect(v.kind === 'verified' && roleOf(v, ERP).roles).toContain('initiator-signer');
  });
});

describe('the member absent for a page that records initiator-signer', () => {
  it('stays g1_initiator_signature_not_carried, the role stays Declared (unchanged behaviour)', () => {
    const d = load('initiator-nonvoting-carried');
    delete d.evidence.initiatingSignature;
    const v = judge(d);
    expect(v.kind).toBe('verified');
    if (v.kind !== 'verified') return;
    expect(v.unproven).toEqual(['g1_initiator_signature_not_carried']);
    expect(roleOf(v, ERP).roles).not.toContain('initiator-signer');
    expect(roleOf(v, ERP).declared).toContain('initiator-signer');
  });
  it('a JSON null member is no member', () => {
    const d = load('initiator-nonvoting-carried');
    d.evidence.initiatingSignature = null;
    const v = judge(d);
    expect(v.kind === 'verified' && v.unproven).toEqual(['g1_initiator_signature_not_carried']);
  });
});

describe('duplicate, differently cased and unknown member keys (Go: json.RawMessage, the last occurrence wins, keys match case-insensitively)', () => {
  const carried = (): Doc => load('initiator-nonvoting-carried');
  const control = judge(carried());

  it('the key repeated with null last: the member is none (last wins)', () => {
    const v = judgeText(spliceMember(carried(), (mj) => `"initiatingSignature":${mj},"initiatingSignature":null`));
    expect(v.kind === 'verified' && v.unproven).toEqual(['g1_initiator_signature_not_carried']);
  });
  it('the key repeated with null first: the member is read (last wins), the verdict is the control verdict', () => {
    const v = judgeText(spliceMember(carried(), (mj) => `"initiatingSignature":null,"initiatingSignature":${mj}`));
    expect(v).toEqual(control);
  });
  it('the key repeated with a value of ANY type first: RawMessage keeps the bytes, the later object is read', () => {
    for (const first of ['"garbage"', '7', '[1,2]', 'true']) {
      const v = judgeText(spliceMember(carried(), (mj) => `"initiatingSignature":${first},"initiatingSignature":${mj}`));
      expect(v, first).toEqual(control);
    }
  });
  it('the key repeated with a value that is no hop object last: the document is refused (plain)', () => {
    for (const last of ['"garbage"', '7', '[1,2]', 'true', '{}']) {
      const v = judgeText(spliceMember(carried(), (mj) => `"initiatingSignature":${mj},"initiatingSignature":${last}`));
      expect(v.kind, last).toBe('plain');
    }
  });
  it('the key spelled in another case is the same member', () => {
    for (const k of ['InitiatingSignature', 'INITIATINGSIGNATURE', 'initiatingsignature']) {
      const v = judgeText(spliceMember(carried(), (mj) => `"${k}":${mj}`));
      expect(v, k).toEqual(control);
    }
  });
  it('a key that only looks like it is not the member: the document carries none', () => {
    for (const k of ['initiatingSignatures', 'initiating_signature', 'initiatingSignature2', ' initiatingSignature']) {
      const v = judgeText(spliceMember(carried(), (mj) => `"${k}":${mj}`));
      expect(v.kind === 'verified' && v.unproven, k).toEqual(['g1_initiator_signature_not_carried']);
    }
  });
  it('a member of the wrong JSON type is a plain refusal of the document', () => {
    for (const bad of ['"x"', '7', '[]', 'true', '{}']) {
      const v = judgeText(spliceMember(carried(), () => `"initiatingSignature":${bad}`));
      expect(v.kind, bad).toBe('plain');
    }
  });
  it('an unknown key inside the member is ignored; a repeated inner key takes its last value', () => {
    const base = carried();
    expect(judgeText(spliceMember(base, (mj) => `"initiatingSignature":{"zzz":1,${mj.slice(1)}`))).toEqual(control);
    expect(judgeText(spliceMember(base, (mj) => `"initiatingSignature":{"page":"acc://bogus.acme/book/1",${mj.slice(1)}`))).toEqual(control);
    const v = judgeText(spliceMember(base, (mj) => `"initiatingSignature":${mj.slice(0, -1)},"page":"acc://bogus.acme/book/1"}`));
    expect(v.kind === 'named' && v.code).toBe('g1_initiator_page_unproven');
  });
});

describe('a carried member is proven completely or refused: never verified with the role unproven, never "partly unproven"', () => {
  const corrupt: Record<string, (m: any) => void> = {
    'page emptied': (m) => (m.page = ''),
    'message emptied': (m) => (m.message = ''),
    'signature emptied': (m) => (m.signature = ''),
    'block zeroed': (m) => (m.block = 0),
    'receipt removed': (m) => delete m.receipt,
    'arrival removed': (m) => delete m.arrival,
    'arrival.at removed': (m) => delete m.arrival.at,
    'arrival.before removed': (m) => delete m.arrival.before,
    'receipt anchor replaced': (m) => (m.receipt.anchor = flip(m.receipt.anchor, 0)),
    'receipt start replaced': (m) => (m.receipt.start = flip(m.receipt.start, 0)),
    'arrival entry replaced': (m) => (m.arrival.at.entry = flip(m.arrival.at.entry, 0)),
  };
  for (const [name, f] of Object.entries(corrupt)) {
    it(name, () => {
      const d = load('initiator-nonvoting-carried');
      f(d.evidence.initiatingSignature);
      const v = judge(d);
      expect(v.kind, 'a corrupted member must not verify').not.toBe('verified');
      if (v.kind === 'named') {
        expect(v.code).not.toBe('g1_initiator_signature_not_carried');
        expect(v.message.toLowerCase()).not.toContain('partly');
      }
    });
  }
});

describe('evidence 2.0 does not read the member (portable.go Import reads it only when the version is 2.1)', () => {
  const fixture = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/proofv2/valid.json.gz', import.meta.url))).toString('utf8')) as Doc;
  // A 2.0 verification takes seconds (the set check); each shape is its own test so none comes near the 20 s limit, and the base report is computed once.
  let baseReport: string | undefined;
  const base = (): string => (baseReport ??= JSON.stringify(verifyPortableAnyBytes(JSON.stringify(fixture)).report));
  for (const m of ['"garbage"', '{}', '[1]']) {
    it(`a verifying 2.0 document verifies the same with the member ${m} added`, () => {
      const plain = JSON.stringify(fixture);
      const text = plain.replace('"evidence":{', `"evidence":{"initiatingSignature":${m},`);
      expect(text).not.toBe(plain);
      const out = verifyPortableAnyBytes(text);
      expect(out.version).toBe('2.0');
      expect(JSON.stringify(out.report)).toBe(base());
    }, 60_000);
  }
  it('a document that claims 2.0 and carries the member with the other 2.1 members is refused', () => {
    const d = load('initiator-nonvoting-carried');
    d.evidence.version = '2.0';
    expect(judge(d).kind).not.toBe('verified');
  });
});

describe('a document without the member verifies exactly as before (no fixture changes)', () => {
  it('the carried vector without the member and the member-absent vector are the same verdict', () => {
    const a = load('initiator-nonvoting-carried');
    delete a.evidence.initiatingSignature;
    const b = load('initiator-member-absent');
    const va = judge(a);
    const vb = judge(b);
    expect(va.kind).toBe('verified');
    expect(vb.kind).toBe('verified');
    if (va.kind === 'verified' && vb.kind === 'verified') {
      expect(va.unproven).toEqual(vb.unproven);
      expect(va.summary.proven.map((p) => [p.url, p.roles, p.declared])).toEqual(vb.summary.proven.map((p) => [p.url, p.roles, p.declared]));
    }
  });
});
