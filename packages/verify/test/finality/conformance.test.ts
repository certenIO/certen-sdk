/**
 * Every code the TypeScript framework raises is in the shared registry states.json (byte-identical to the validator's), with exactly its
 * required fields and a member of each closed reason enum (the twin of pkg/finality state_test.go and state_strict_test.go).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { newAddendum, legBindingOf } from '../../src/proof-v2/finality/addendum.js';
import { encodeContainer } from '../../src/proof-v2/finality/codec.js';
import { Level } from '../../src/proof-v2/finality/level.js';
import {
  AddendumReason,
  Check,
  Code,
  EvidenceReason,
  FinalityStateError,
  FinalizedBlockReason,
  IncludedReason,
  NotApplicableReason,
  PinsReason,
  addendumMalformed,
  blockMismatch,
  canonValue,
  chainBroken,
  chainUnsupported,
  evidenceTooLarge,
  evidenceUnrecognised,
  finalizedBlockUnavailable,
  includedUnavailable,
  lvl,
  malformed,
  malformedAt,
  newState,
  noEvidenceInFile,
  notApplicableState,
  pendingState,
  pinsCorrupt,
  type Fields,
} from '../../src/proof-v2/finality/state.js';
import { ChainBaseSepolia, ChainSepolia, kindFor } from '../../src/proof-v2/finality/table.js';
import { triple } from '../../src/proof-v2/finality/evidence.js';
import { fill, fixtureJSON } from './helpers.js';

interface StateSpec {
  group: string;
  optional: string[];
  required: string[];
  scope: string;
  enums?: Record<string, string[]>;
  enums_defined_by?: Record<string, string>;
  conditional_required?: { when: Record<string, string>; required: string[] }[];
}
interface Registry {
  format: string;
  pending_reasons: Record<string, { required: string[] }>;
  states: Record<string, StateSpec>;
}

const reg = fixtureJSON<Registry>('finality', 'states.json');

/** The twin of state_test.go conforms(): '' when s conforms, else why not. */
function conforms(s: FinalityStateError): string {
  const spec = reg.states[s.code];
  if (!spec) return `code ${s.code} is not registered`;
  const required = [...spec.required];
  if (s.code === Code.Pending) {
    const reason = s.fields.reason as string;
    const pr = reg.pending_reasons[reason];
    if (!pr) return `finality_pending reason ${reason} is not in the closed set`;
    required.push(...pr.required);
  }
  for (const c of spec.conditional_required ?? []) {
    if (Object.entries(c.when).every(([k, v]) => String(s.fields[k]) === v)) required.push(...c.required);
  }
  const allowed = new Set<string>();
  for (const f of required) {
    allowed.add(f);
    if (!(f in s.fields)) return `${s.code} lacks required field ${f}`;
  }
  for (const [f, set] of Object.entries(spec.enums ?? {})) {
    if (!(f in s.fields)) continue;
    if (!set.includes(String(s.fields[f]))) return `${s.code} field ${f} = ${String(s.fields[f])} is not in its closed set`;
  }
  for (const f of spec.optional) allowed.add(f);
  for (const f of Object.keys(s.fields)) if (!allowed.has(f)) return `${s.code} carries unregistered field ${f}`;
  return '';
}

const section7Codes = [
  'finality_chain_unsupported', 'finality_ledger_extension_invalid', 'finality_chain_broken', 'finality_evidence_unrecognised',
  'finality_evidence_malformed', 'finality_block_mismatch', 'finality_evidence_too_large', 'finality_pins_corrupt',
  'level_not_applicable', 'finality_pending',
  'finality_network_mismatch', 'finality_fork_unsupported', 'finality_pin_unknown', 'finality_pin_mismatch', 'finality_pin_window',
  'finality_bootstrap_invalid', 'finality_link_invalid', 'finality_participation_insufficient', 'finality_signature_invalid',
  'finality_period_gap', 'finality_block_not_covered', 'finality_ledger_behind', 'finality_header_chain_broken', 'l1_finality_unproven',
  'game_challenger_wins', 'game_not_resolved', 'game_within_finality_delay', 'game_blacklisted', 'game_retired', 'game_not_respected',
  'game_not_registered', 'l1_system_paused', 'contract_identity_unproven', 'game_type_unsupported', 'game_unrecognised',
  'output_root_mismatch', 'l2_block_not_canonical', 'l1_state_proof_invalid', 'l1_tx_proof_invalid', 'batcher_sender_mismatch',
  'batcher_tx_not_to_inbox', 'blob_commitment_mismatch', 'channel_incomplete', 'channel_timed_out', 'channel_malformed',
  'batch_not_found', 'batch_binding_mismatch', 'batch_outside_sequencing_window', 'batch_format_unsupported',
  'rollup_unpinned', 'pin_mismatch', 'assertion_preimage_mismatch', 'assertion_machine_not_finished', 'assertion_not_confirmed',
  'assertion_unknown', 'header_chain_exceeds_bound', 'confirmed_by_owner_force', 'confirmation_path_unproven',
  'l1_posted_content_not_found', 'l1_batch_data_off_l1', 'l1_batch_header_unknown', 'l1_posted_delayed_origin_unproven', 'pre_bold_block',
  'adiri_incarnation_mismatch', 'evidence_pin_mismatch', 'committee_chain_broken', 'epoch_record_codec_unsupported',
  'finality_link_broken', 'committee_shrunk',
  'l1_blob_unavailable', 'batcher_state_unavailable', 'l2_headers_unavailable', 'l2_header_unavailable',
  'assertion_history_unavailable', 'finality_source_unavailable', 'level_already_present',
];

const section7PendingReasons = [
  'no_evidence_in_file', 'block_not_yet_covered', 'no_covering_game', 'game_unresolved', 'within_finality_delay', 'l1_posted_unproven',
  'awaiting_batch_post', 'awaiting_l1_finality_of_batch', 'awaiting_covering_assertion', 'awaiting_assertion_confirmation',
  'awaiting_l1_finality_of_confirmation', 'epoch_open', 'epoch_certificate_pending', 'epoch_overdue',
  'l1_proof_window_unavailable', 'l1_state_unavailable', 'finality_lc_unavailable', 'finality_ledger_incomplete', 'history_proof_unavailable',
];

describe('the shared registry', () => {
  it('holds every code of section 7 under scope spec and nothing else under spec', () => {
    expect(reg.format).toBe('certen-finality-states/2');
    const want = new Set(section7Codes);
    for (const c of section7Codes) expect(reg.states[c]?.scope, c).toBe('spec');
    for (const [c, s] of Object.entries(reg.states)) {
      if (s.scope === 'spec') expect(want.has(c), `${c} has scope spec but is not a section 7 code`).toBe(true);
      else expect(s.scope, c).toBe('go_operational');
      expect([...s.required], c).toEqual([...s.required].sort());
      expect([...s.optional], c).toEqual([...s.optional].sort());
    }
    for (const r of section7PendingReasons) expect(reg.pending_reasons[r], r).toBeDefined();
    expect(Object.keys(reg.pending_reasons).length).toBe(section7PendingReasons.length);
  });
});

describe('every state the framework builds conforms to its registry entry', () => {
  const b = { chain: ChainBaseSepolia, number: 47368146n, hash: fill(0x33) };
  const levelOneErr = (() => { try { kindFor(ChainBaseSepolia, Level.Included); } catch (e) { return e as FinalityStateError; } throw new Error('no error'); })();
  const naErr = (() => { try { kindFor(ChainSepolia, Level.L1Posted); } catch (e) { return e as FinalityStateError; } throw new Error('no error'); })();
  const unsupportedErr = (() => { try { kindFor(1n, Level.Finalized); } catch (e) { return e as FinalityStateError; } throw new Error('no error'); })();
  const dupErr = (() => {
    const ev = encodeContainer({ header: { kind: 'base-sepolia/finalized/v1', chain: b.chain, level: Level.Finalized, blockNumber: b.number, blockHash: b.hash }, body: new Uint8Array() });
    const first = newAddendum(legBindingOf(b), new Uint8Array(16), [], b.chain, Level.Finalized, 'base-sepolia/finalized/v1', ev);
    try { newAddendum(legBindingOf(b), new Uint8Array(16), [first], b.chain, Level.Finalized, 'base-sepolia/finalized/v1', ev); } catch (e) { return e as FinalityStateError; }
    throw new Error('no error');
  })();
  const cases: Record<string, FinalityStateError> = {
    Malformed: malformed('part', EvidenceReason.Truncated, 1, 2),
    MalformedAt: malformedAt('part', 3, EvidenceReason.HeaderItemIsList, 1, 2),
    AddendumMalformed: addendumMalformed('seq', AddendumReason.BadValue),
    AddendumMalformedKey: addendumMalformed('addendum', AddendumReason.UnknownKey, { key: 'Seq' }),
    IncludedUnavailable: includedUnavailable(IncludedReason.NoSettlement, { chain: 1n }),
    FinalizedBlockState: finalizedBlockUnavailable(1n, 2n, FinalizedBlockReason.HeaderUnreadable, { index: 8n }),
    EvidenceTooLarge: evidenceTooLarge('part', 5, 4),
    EvidenceUnrecognised: evidenceUnrecognised('k', 'v1'),
    ChainUnsupported: chainUnsupported(1n),
    ChainBroken: chainBroken(2, Check.SeqGap, { want: 3n }),
    'ChainBroken legbind': chainBroken(0, Check.LegBinding, { want: triple(b), got: triple(b) }),
    'ChainBroken kind': chainBroken(1, Check.Kind, { chain: 1n, level: lvl(Level.Finalized), kind: 'x' }),
    BlockMismatch: blockMismatch('blockNumber', 1n, 2n),
    PinsCorrupt: pinsCorrupt(PinsReason.SHA256Mismatch, { want_sha256: fill(1), got_sha256: fill(2) }),
    'PinsCorrupt indexed': pinsCorrupt(PinsReason.AnchorWspBelow256, { index: 3n }),
    NotApplicableState: notApplicableState(ChainSepolia, Level.L1Posted, NotApplicableReason.ChainIsL1),
    NoEvidenceInFile: noEvidenceInFile(ChainSepolia, Level.Included, Level.Finalized),
    'Pending with eta': pendingState({ chain: 1n, levelReached: Level.Included, nextLevel: Level.Finalized, reason: 'epoch_open', eta: new Date(1000) }),
    'KindFor n/a': naErr,
    'KindFor unsupported': unsupportedErr,
    'KindFor level 1': levelOneErr,
    'level already': dupErr,
    'pins unknown': newState(Code.PinUnknown, { chain: ChainSepolia, kind: 'eth_sepolia', period: 1n }),
    'verifier failed': newState(Code.VerifierFailed, { chain: 1n, kind: 'k', cause: 'c' }),
    'included invalid': newState(Code.IncludedInvalid, { chain: 1n, cause: 'c' }),
  };
  it.each(Object.entries(cases))('%s', (_n, s) => expect(conforms(s)).toBe(''));

  it('builds every registered pending reason with exactly its required extra fields', () => {
    for (const [reason, spec] of Object.entries(reg.pending_reasons)) {
      const judged: Fields = {};
      for (const f of spec.required) judged[f] = 'x';
      const s = pendingState({ chain: 1n, levelReached: Level.Included, nextLevel: Level.Finalized, reason, judged });
      expect(conforms(s), reason).toBe('');
    }
  });

  it('refuses a leg_binding chain_broken without want and got, a reason outside its closed set, an unregistered field and code', () => {
    expect(conforms(chainBroken(0, Check.LegBinding))).toMatch(/lacks required field/);
    expect(conforms(malformed('p', 'a Go sentence', 0, 0))).toMatch(/not in its closed set/);
    expect(conforms(newState(Code.ChainUnsupported, { chain: 1n, extra: 1n }))).toMatch(/unregistered field extra/);
    expect(conforms(newState('finality_made_up', {}))).toMatch(/not registered/);
    expect(conforms(newState(Code.Pending, { chain: 1n, level_reached: lvl(1), next_level: lvl(3), reason: 'nope' }))).toMatch(/closed set/);
  });
});

describe('the typed reason constants are exactly the registry\'s closed sets', () => {
  const values = (o: Record<string, string>): string[] => Object.values(o).sort();
  it.each([
    ['finality_evidence_malformed', 'reason', EvidenceReason],
    ['finality_addendum_malformed', 'reason', AddendumReason],
    ['finality_pins_corrupt', 'reason', PinsReason],
    ['finality_included_unavailable', 'reason', IncludedReason],
    ['finality_finalized_block_unavailable', 'reason', FinalizedBlockReason],
    ['level_not_applicable', 'reason', NotApplicableReason],
    ['finality_chain_broken', 'check', Check],
  ] as const)('%s.%s', (code, field, consts) => {
    expect(values(consts)).toEqual([...(reg.states[code]!.enums![field]!)].sort());
  });

  it('every state with a reason field has a closed set or names the package that defines it', () => {
    for (const [code, s] of Object.entries(reg.states)) {
      const hasReason = [...s.required, ...s.optional].includes('reason');
      if (!hasReason || code === Code.Pending) continue; // finality_pending's reason is the registry's pending_reasons set
      const closed = s.enums?.reason !== undefined;
      const defined = s.enums_defined_by?.reason !== undefined;
      expect(closed || defined, `${code} has a free-text reason`).toBe(true);
    }
  });
});

describe('no code outside the registry is raised anywhere in the TypeScript sources', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'proof-v2', 'finality');
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  it('reads the finality sources', () => expect(sources.length).toBeGreaterThanOrEqual(12));
  it('every code literal and every Code constant is registered', () => {
    const lit = /'((?:finality_[a-z0-9_]+)|level_not_applicable|level_already_present)'/g;
    let seen = 0;
    for (const f of sources) {
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(lit)) {
        seen++;
        expect(reg.states[m[1]!], `${f}: ${m[1]}`).toBeDefined();
      }
    }
    expect(seen).toBeGreaterThan(10);
    for (const c of Object.values(Code)) expect(reg.states[c], c).toBeDefined();
  });
});

describe('the canonical form', () => {
  it('is sorted, writes every integer width as a decimal string, bytes as 0x hex, and is deterministic', () => {
    const s = newState('finality_chain_broken', {
      seq: 18446744073709551615n, check: 'own_hash', level: lvl(Level.Finalized), h: fill(0xab),
      nested: { z: 1n, a: Uint8Array.of(1, 2) }, ok: true, none: null, t: new Date(0), small: 7, neg: -5, empty: new Uint8Array(0),
    });
    const want = `{"code":"finality_chain_broken","fields":{"check":"own_hash","empty":"0x","h":"0x${'ab'.repeat(32)}","level":"finalized","neg":"-5",` +
      `"nested":{"a":"0x0102","z":"1"},"none":null,"ok":true,"seq":"18446744073709551615","small":"7","t":"1970-01-01T00:00:00Z"}}`;
    expect(s.canonical()).toBe(want);
    expect(s.canonical()).toBe(want);
  });
  it('quotes strings as Go 1.25 encoding/json does with HTML escaping off', () => {
    expect(canonValue('<a&b>"\\\n\t\b\f\u0001 \u007f')).toBe('"<a&b>\\"\\\\\\n\\t\\b\\f\\u0001\\u2028\u007f"');
  });
  it('orders keys by UTF-8 bytes, not UTF-16 code units', () => {
    expect(canonValue({ '\u{1F600}': 1n, '～': 2n })).toBe('{"～":"2","\u{1F600}":"1"}');
  });
  it('refuses an integer that is not exact instead of rounding it', () => {
    expect(() => canonValue(2 ** 60)).toThrow();
  });
});
