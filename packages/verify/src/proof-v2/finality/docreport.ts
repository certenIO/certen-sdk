/**
 * The finality section of a portable proof v2 document, judged and reported (the twin of cmd/proofverify/finality.go: reportFinalityFile, printReport
 * and notCoveredByThePins; the exit classes 0 / 3 / 1 of that tool are `verified` / `summary_only` / `failed` here).
 *
 * The portable document's `finality` member (certen-finality-addenda/1) is read the way Go reads it: the document text is parsed by the Go-faithful
 * reader and decoded into a struct with the one member `finality` (json.RawMessage: matched exactly else case-insensitively, the last repeated key
 * wins, `null` is no section), then the member is read strictly by parseSection (addendum.ts). With a Settlement for the leg (FinalityOptions.settlement)
 * the leg is judged exactly as the database path judges a stored leg: the Settlement is verified (level 1, derived), D0 is the LegBinding of its block
 * and never read from the file, the carried `leg` member must equal that block (finality_chain_broken{leg_binding}), the chain of addenda is recomputed
 * under D0 and each addendum is judged by its registered Kind. WITHOUT a Settlement the document holds nothing to recompute D0 from: no level is judged and
 * none is claimed, and the result says so by name (finality_included_unavailable, summary-only).
 *
 * Nothing here throws for input that does not check: every refusal is a class with the named state that decided it, and `text` is the report Go prints,
 * line for line. `text` differs from Go's in exactly two places, both about HOW to name a Settlement (a command line flag there, an option here): the hint of
 * the no-Settlement report and the note that no Kind is registered in this call.
 */
import { foldEqual } from '../../s3/fold.js';
import { JsonError } from '../../s3/gojson.js';
import { decodeVal, parseGoJson, type GoVal, type Raw, type Sch } from '../../s3/jsonx.js';
import { VerifyError } from '../bytes.js';
import { carriedLegRef, parseSectionValue, type Section } from './addendum.js';
import type { Settlement } from './evidence.js';
import { LEVELS, Level, levelName } from './level.js';
import { embeddedPins, type Pins } from './pins.js';
import { Registry } from './registry.js';
import { verifyCarried, verifyWith, type Report } from './report.js';
import { Code, IncludedReason, asNamed, hexLower, includedUnavailable, type FinalityStateError } from './state.js';
import { CodeL1FinalityUnproven, CodeLedgerBehind } from './ethl1/fault.js';

/** The class of a finality verdict: the headline of the report and, in Go, the exit code of the tool. */
export type FinalityClass = 'verified' | 'summary_only' | 'failed';

/** The exit code of Go's proofverify for each class. */
export const EXIT_CODE: Readonly<Record<FinalityClass, 0 | 1 | 3>> = { verified: 0, summary_only: 3, failed: 1 };

/** The Settlement a section is judged against: the chain it settled on, the Settlement itself (null: none), and where it came from (printed). */
export interface LegSettlement {
  chain: bigint;
  settlement: Settlement | null;
  source?: string;
}

/** What the caller may bring to the finality section. Every member is optional. */
export interface FinalityOptions {
  /** The leg's Settlement. Without it the section judges no level and says so (finality_included_unavailable). */
  settlement?: LegSettlement;
  /** A pins file the caller trusts (parsePinsOverride); the embedded pins when absent. */
  pins?: Pins | null;
  /** The Kinds the section is judged by (registerAllKinds into a Registry); a registry holding no Kind when absent (see DocumentFinality.noKinds). */
  registry?: Registry;
  /** What the report calls the document (Go prints the file path). */
  subject?: string;
}

export interface DocumentFinality {
  class: FinalityClass;
  /** Go's exit code for this class: 0, 3 or 1. */
  exit: 0 | 1 | 3;
  /** The report Go prints for this judgement (see the header for the two lines that differ). */
  text: string;
  /** The level reached, when a leg was judged. */
  headline?: Level;
  /** The per-level report, when a leg was judged. */
  report?: Report;
  /** The named state that decided a summary-only or failed class that carries no report. */
  state?: FinalityStateError;
  /** True when the call carried a Settlement but no registry: no Kind was registered, so every addendum is finality_evidence_unrecognised. */
  noKinds?: true;
  /** True when the verifier itself could not be wired (pins or Kinds refused to load): Go refuses to start in that case. */
  wiring?: { stage: 'pins' | 'kinds'; state?: FinalityStateError; message: string };
}

/**
 * Members that hold the framework's own objects (a Report with maps and bigints, a state with byte fields) are NOT enumerable: a DocumentFinality
 * serialises with JSON.stringify (class, exit, text, headline) and the structured members stay reachable by name.
 */
function hide<T extends object>(o: T, hidden: Record<string, unknown>): T {
  for (const [k, v] of Object.entries(hidden)) if (v !== undefined) Object.defineProperty(o, k, { value: v, enumerable: false, writable: true, configurable: true });
  return o;
}

const DOC_SCHEMA: Sch ={ struct: [{ name: 'Finality', json: 'finality', sch: 'raw' }] };

/** printReport's refusal that does not say the evidence is wrong, only that this verifier cannot judge it (notCoveredByThePins). */
export function notCoveredByThePins(st: FinalityStateError | undefined): boolean {
  if (st === undefined) return false;
  switch (st.code) {
    case Code.EvidenceUnrecognised:
    case Code.PinUnknown:
    case CodeLedgerBehind:
      return true;
    case CodeL1FinalityUnproven:
      return st.fields.inner === CodeLedgerBehind;
  }
  return false;
}

const hexOf = (b: Uint8Array): string => hexLower(b);

/**
 * printReport: one leg's per-level verdicts and the leg's class. A refused level that is not covered by the pins is summary-only, any other refusal
 * is failed, and failed beats summary-only whatever the order of the levels.
 */
export function renderReport(rep: Report, subject: string): { class: FinalityClass; exit: 0 | 1 | 3; text: string } {
  const done = (cls: FinalityClass, text: string): { class: FinalityClass; exit: 0 | 1 | 3; text: string } => ({ class: cls, exit: EXIT_CODE[cls], text });
  if (rep.unsupported !== undefined) return done('summary_only', `SUMMARY-ONLY (finality)  ${subject}\n  ${rep.unsupported.toString()}\n`);
  const inc = rep.levels.get(Level.Included);
  if (inc !== undefined && inc.status === 'refused') {
    return done('failed', `FAILED (finality)  ${subject}\n  the leg's Settlement does not verify as the included level: ${inc.state === undefined ? '<nil>' : inc.state.toString()}\n`);
  }
  let text = `  S7  chain ${rep.block.chain}  block ${rep.block.number}  ${hexOf(rep.block.hash.subarray(0, 6))}…  pins ${rep.pinsSha256} (${rep.pinsSource})\n`;
  for (const l of LEVELS) {
    const st = rep.levels.get(l);
    let line = `  S7    ${levelName(l).padEnd(9)}  ${st === undefined ? '' : st.status}`;
    if (st !== undefined && st.state !== undefined) line += `  ${st.state.toString()}`;
    text += `${line}\n`;
  }
  text += `  S7  level reached: ${levelName(rep.headline)}\n`;
  if (rep.finalizedBlock !== undefined) {
    text += `  S7  finalized_block: number ${rep.finalizedBlock.number} hash ${hexOf(rep.finalizedBlock.hash)} stateRoot ${hexOf(rep.finalizedBlock.stateRoot)}\n`;
  }
  if (rep.finalizedBlockState !== undefined) {
    return done('failed', `${text}FAILED (finality)  ${subject}\n  the finalized level is verified but the leg block cannot be exposed for S8: ${rep.finalizedBlockState.toString()}\n`);
  }
  if (rep.broken !== undefined) {
    return done('failed', `${text}FAILED (finality)  ${subject}\n  the addendum chain does not verify: ${rep.broken.toString()}\n`);
  }
  let cls: FinalityClass = 'verified';
  for (const l of [Level.L1Posted, Level.Finalized]) {
    const st = rep.levels.get(l);
    if (st !== undefined && st.status === 'refused') {
      if (notCoveredByThePins(st.state)) {
        if (cls === 'verified') cls = 'summary_only';
      } else cls = 'failed';
    }
  }
  const headline = levelName(rep.headline);
  switch (cls) {
    case 'failed':
      return done(cls, `${text}FAILED (finality)  ${subject}\n  an addendum's evidence is present and does not check out\n`);
    case 'summary_only':
      return done(
        cls,
        `${text}SUMMARY-ONLY (finality)  ${subject}\n  an addendum's kind or pins are not known to this verifier; nothing is known to be wrong, and the levels above\n  ${headline} are not judged here.\n`,
      );
  }
  return done(cls, `${text}VERIFIED (finality)  ${subject}  level ${headline}\n`);
}

const failed = (subject: string, body: string, state?: FinalityStateError): DocumentFinality =>
  hide({ class: 'failed', exit: 1, text: `FAILED (finality)  ${subject}\n  ${body}\n` } as DocumentFinality, { state });

/** The document text parsed as Go parses it into `struct{ Finality json.RawMessage }`; the member (undefined: absent, null: no section). */
function memberOf(input: string | Uint8Array): { member: ReturnType<typeof parseGoJson> | undefined } | { error: string } {
  try {
    const decoded = decodeVal(DOC_SCHEMA, parseGoJson(input), 'doc') as { [field: string]: GoVal };
    return { member: (decoded.Finality as Raw).v };
  } catch (e) {
    if (e instanceof JsonError || e instanceof VerifyError) return { error: e.message };
    throw e;
  }
}

/**
 * reportFinalityFile over the document text. `input` is the document as it was received (a string or its bytes); verifyPortable's convention for a
 * document already parsed with JSON.parse applies (see judgeFinalityDocument): a parsed tree has lost repeated keys and the spelling of numbers.
 */
export function judgeFinalityText(input: string | Uint8Array, opts: FinalityOptions = {}): DocumentFinality {
  const subject = opts.subject ?? 'document';
  const got = memberOf(input);
  if ('error' in got) return failed(subject, `not a portable document: ${got.error}`);
  if (got.member === undefined || got.member === null) {
    return {
      class: 'summary_only',
      exit: 3,
      text: `SUMMARY-ONLY (finality)  ${subject}\n  the document carries no finality section: no level beyond the proof itself is evidenced.\n`,
    };
  }
  let section: Section;
  try {
    section = parseSectionValue(got.member);
  } catch (e) {
    const st = asNamed(e);
    if (st === undefined) throw e;
    return failed(subject, st.toString(), st);
  }
  const leg = opts.settlement;
  if (leg === undefined && section.leg.headerRlp === undefined) {
    const st = includedUnavailable(IncludedReason.SettlementNotJudged, { chain: section.leg.chain });
    return hide(
      {
        class: 'summary_only',
        exit: 3,
        text:
          `SUMMARY-ONLY (finality)  ${subject}\n  ${st.toString()}\n  S7  carried leg: chain ${section.leg.chain} block ${section.leg.blockNumber} ${section.leg.blockHash}; ` +
          `${section.addenda.length} addenda are not judged (name the Settlement: FinalityOptions.settlement)\n`,
      } as DocumentFinality,
      { state: st },
    );
  }
  let carried;
  try {
    carried = carriedLegRef(section.leg);
  } catch (e) {
    const st = asNamed(e);
    if (st === undefined) throw e;
    return failed(subject, st.toString(), st);
  }
  let pins: Pins | null;
  try {
    pins = opts.pins === undefined ? embeddedPins() : opts.pins;
  } catch (e) {
    const st = asNamed(e);
    if (st === undefined) throw e;
    const w = { stage: 'pins' as const, state: st, message: st.toString() };
    return hide(failed(subject, `the verifier cannot be wired: its pins do not load: ${w.message}`, st), { wiring: w });
  }
  const reg = opts.registry ?? new Registry();
  if (leg === undefined) {
    // no Settlement source, but the leg carries its header (bound by carriedLegRef to blockHash and blockNumber): D0 is recomputed from that block and
    // the addenda are judged against it; the header proves the block, not the settlement transaction, so level 1 is not claimed
    const rep = verifyCarried(reg, carried, section.addenda, pins);
    const r = renderReport(rep, subject);
    const note = opts.registry === undefined ? '  S7  no verifier Kind is registered in this call: every addendum is unrecognised (pass FinalityOptions.registry, see finality.registerKinds)\n' : '';
    const src =
      `  S7  Settlement source: none; the leg carries its block header (leg.headerRlp, bound to blockHash and blockNumber): it proves block ${carried.number}, ` +
      'not the settlement transaction, so level 1 (included) is not judged\n';
    const out = hide({ class: r.class, exit: r.exit, text: `${src}${note}${r.text}`, headline: rep.headline } as DocumentFinality, { report: rep });
    if (opts.registry === undefined) out.noKinds = true;
    return out;
  }
  const rep = verifyWith(reg, leg.chain, leg.settlement, carried, section.addenda, pins);
  const r = renderReport(rep, subject);
  const note = opts.registry === undefined ? '  S7  no verifier Kind is registered in this call: every addendum is unrecognised (pass FinalityOptions.registry, see finality.registerKinds)\n' : '';
  const out = hide({ class: r.class, exit: r.exit, text: `  S7  Settlement source: ${leg.source ?? 'caller'}\n${note}${r.text}`, headline: rep.headline } as DocumentFinality, { report: rep });
  if (opts.registry === undefined) out.noKinds = true;
  return out;
}

/** judgeFinalityText over a document already decoded by JSON.parse: its text is JSON.stringify(document), as verifyPortable reads it. */
export function judgeFinalityDocument(document: unknown, opts: FinalityOptions = {}): DocumentFinality {
  const text = JSON.stringify(document);
  if (text === undefined) return failed(opts.subject ?? 'document', 'not a portable document: not JSON');
  return judgeFinalityText(text, opts);
}

/** True when a decoded document carries a finality member that is not null (the keys Go would match as `finality`: exact, else case-insensitive). */
export function carriesFinality(document: unknown): boolean {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return false;
  const o = document as Record<string, unknown>;
  const key = Object.keys(o).filter((k) => k === 'finality' || foldEqual('finality', k));
  if (key.length === 0) return false;
  // the last matching key in document order decides, as in Go (an exact key and a folded one are both "the field")
  const v = o[key[key.length - 1]!];
  return v !== null && v !== undefined;
}
