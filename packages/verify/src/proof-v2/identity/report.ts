// The report model of the S8 verifier and its comparison with a vector's `expected` (twin of pkg/contractidentity types.go, report.go and
// vectors.go MatchExpected). `verified_core` is a headline of its own: nothing here prints it as, counts it as or compares it with `verified`.
import { canonical, type CanonValue } from './canon.js';
import * as N from './names.js';
import type { AuthorityObject } from './framework.js';
import { defaultVocabulary, type StateError } from './states.js';

export type PartStatus = 'verified' | 'refused' | 'unproven' | 'not_applicable' | 'open';
export interface OpenEntry { part: string; kind: string; state: StateError }
export interface PartResult { part: string; status: PartStatus; state?: StateError; reason?: string; open?: OpenEntry[] }
export interface Finding { part: string; state: StateError | undefined }

export const JudgedParts: readonly string[] = [
  N.JudgedSettlementPath, N.JudgedS6Link, N.JudgedCodeIdentity, N.JudgedAccountProvenance, N.JudgedPointer, N.JudgedAuthorityLevel, N.JudgedRecord,
  N.JudgedAuthorizationAttest, N.JudgedIntraBlockWindow, N.JudgedRegistryLink, N.JudgedStateAtSettlement,
];

export function isCoreJudgedPart(part: string, registry9: boolean): boolean {
  if (part === N.JudgedRegistryLink) return registry9;
  if (part === N.JudgedStateAtSettlement) return false;
  return JudgedParts.includes(part);
}

export interface HeadlineInput {
  parts?: PartResult[]; framework?: StateError; registry9?: boolean; stateRootAuthenticated?: boolean; levelReached?: string;
  s7FinalizedStatus?: string; judgedAtLevel?: string; stateRoot?: Uint8Array; block?: bigint; registryLink?: string;
}
export interface Headline {
  kind: string; first?: StateError; parts: string[]; levelReached?: string; findings?: Finding[]; s7FinalizedStatus?: string; open?: OpenEntry[];
  judgedAtLevel?: string; stateRoot?: Uint8Array; block?: bigint; registryLink?: string; notApplicable?: StateError;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const fieldsOf = (s: StateError): string => canonical(s.fields as { [k: string]: CanonValue });

export function sortOpen(o: OpenEntry[]): OpenEntry[] {
  return o.sort((a, b) => cmp(a.part, b.part) || cmp(a.state.code, b.state.code) || cmp(fieldsOf(a.state), fieldsOf(b.state)));
}

/** The headline algebra (headlineAlgebra in types.go); `framework` outranks everything. */
export function computeHeadline(inp: HeadlineInput): Headline {
  const byPart: (PartResult | undefined)[] = JudgedParts.map(() => undefined);
  for (const p of inp.parts ?? []) {
    const k = JudgedParts.indexOf(p.part);
    if (k >= 0) byPart[k] = p;
  }
  const naPath = byPart[0]?.status === 'not_applicable';
  const refused: string[] = [];
  const unprovenCore: string[] = [];
  const findings: Finding[] = [];
  let firstRefusal: StateError | undefined;
  JudgedParts.forEach((name, k) => {
    const p = byPart[k];
    if (!p) return;
    if (p.status === 'refused') {
      refused.push(name);
      firstRefusal ??= p.state;
      findings.push({ part: name, state: p.state });
    } else if (p.status === 'unproven' && isCoreJudgedPart(name, inp.registry9 ?? false)) unprovenCore.push(name);
  });
  const open = sortOpen(byPart.flatMap((p) => p?.open ?? []));
  const level = inp.levelReached ?? '';
  if (inp.framework) return { kind: N.HeadlineRefused, first: inp.framework, parts: refused };
  if (refused.length > 0 && inp.stateRootAuthenticated) return { kind: N.HeadlineRefused, first: firstRefusal, parts: refused };
  const pending = (withFindings: boolean): Headline => {
    if (level === '') throw new Error('contractidentity: headline: pending without level_reached');
    return { kind: N.HeadlinePending, parts: [], levelReached: level, ...(withFindings ? { findings } : {}), s7FinalizedStatus: inp.s7FinalizedStatus ?? '' };
  };
  if (refused.length > 0) return pending(true);
  if (unprovenCore.length > 0) return { kind: N.HeadlineUnproven, parts: unprovenCore };
  if (naPath) return { kind: N.HeadlineNotApplicable, parts: [], notApplicable: byPart[0]!.state! };
  if (!inp.stateRootAuthenticated) return pending(false);
  if (open.length > 0) return { kind: N.HeadlineVerifiedCore, parts: [], open };
  if (!defaultVocabulary().check('registry_link_value', inp.registryLink ?? '')) throw new Error(`contractidentity: headline: verified needs a registry_link value of the vocabulary, got "${inp.registryLink ?? ''}"`);
  if ((inp.judgedAtLevel ?? '') === '') throw new Error('contractidentity: headline: verified without judged_at_level');
  return { kind: N.HeadlineVerified, parts: [], judgedAtLevel: inp.judgedAtLevel!, stateRoot: inp.stateRoot!, block: inp.block!, registryLink: inp.registryLink! };
}

export interface RuleNotJudged { row: string; reason: string }
export interface S6Report { status: string; reason?: string; state?: string }
export interface Report {
  headline: Headline; parts: PartResult[]; chain?: bigint; rulesJudged: string[]; rulesNotJudged: RuleNotJudged[]; residuals: string[]; s7FinalizedStatus: string;
  registry?: { [k: string]: CanonValue }; authority?: AuthorityObject; s6?: S6Report; judgedAtLevel: string; stateRootAuthenticated: boolean; block: bigint; blockHash: Uint8Array;
  manifestSha256?: string; manifestSource?: string;
}
export const openEntries = (r: Report): OpenEntry[] => sortOpen(r.parts.flatMap((p) => p.open ?? []));

// ---- the vector expectation (FORMAT.md `expected`) and its comparison ----

export interface ExpectedState { part: string; code: string; fields?: { [k: string]: CanonValue } }
export interface ExpectedOpen { part: string; kind: string; code: string; fields?: { [k: string]: CanonValue } }
export interface Expected {
  headline: string; parts?: Record<string, string>; states?: ExpectedState[]; open?: ExpectedOpen[]; registry?: { [k: string]: CanonValue };
  rules_not_judged?: RuleNotJudged[]; s7_finalized_status?: string;
}

/** A JSON number anywhere in an expected value never matches a canonical state (the canonical form has decimal strings only). */
function hasNumber(v: unknown): boolean {
  if (typeof v === 'number') return true;
  if (Array.isArray(v)) return v.some(hasNumber);
  if (v !== null && typeof v === 'object') return Object.values(v as object).some(hasNumber);
  return false;
}
const sameFields = (have: StateError, want: { [k: string]: CanonValue } | undefined): boolean =>
  !hasNumber(want ?? {}) && canonical(have.fields as { [k: string]: CanonValue }) === canonical(want ?? {});

/** FORMAT-R2 `registry`: objects match member by member (a subset of the report's), lists and scalars exactly, all in canonical form. */
function registrySubset(path: string, have: CanonValue, want: CanonValue): string | undefined {
  const isObj = (v: CanonValue): v is { readonly [k: string]: CanonValue } => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);
  if (isObj(want)) {
    if (!isObj(have)) return `${path}: the report has no object`;
    for (const [k, w] of Object.entries(want)) {
      if (!(k in have)) return `${path}.${k}: absent from the report`;
      const why = registrySubset(`${path}.${k}`, have[k]!, w);
      if (why) return why;
    }
    return undefined;
  }
  return !hasNumber(want) && canonical(have) === canonical(want) ? undefined : `${path}: ${canonical(have)}, expected ${canonical(want)}`;
}

/** Returns undefined when the report satisfies `e`, else the reason it does not (MatchExpected). */
export function matchExpected(e: Expected, r: Report): string | undefined {
  if (r.headline.kind === '') return 'the report has no headline';
  if (r.headline.kind !== e.headline) return `headline ${r.headline.kind}, expected ${e.headline}`;
  const byPart = new Map(r.parts.map((p) => [p.part, p] as const));
  for (const [part, want] of Object.entries(e.parts ?? {})) {
    const got = byPart.get(part);
    if (!got || got.status !== want) return `part ${part} is "${got?.status ?? ''}", expected ${want}`;
  }
  for (const s of e.states ?? []) {
    const got = s.part === 'first' ? r.headline.first : byPart.get(s.part)?.state;
    if (!got) return `part ${s.part} carries no state, expected ${s.code}`;
    if (got.code !== s.code || !sameFields(got, s.fields)) return `part ${s.part} state ${got.canonical()}, expected ${s.code}${canonical(s.fields ?? {})}`;
  }
  if (e.registry && Object.keys(e.registry).length > 0) {
    if (!r.registry) return 'the report has no registry object';
    const why = registrySubset('registry', r.registry, e.registry);
    if (why) return why;
  }
  if (e.rules_not_judged) {
    if (r.rulesNotJudged.length !== e.rules_not_judged.length) return `${r.rulesNotJudged.length} rules_not_judged rows, expected ${e.rules_not_judged.length}`;
    for (const [i, w] of e.rules_not_judged.entries()) if (r.rulesNotJudged[i]!.row !== w.row || r.rulesNotJudged[i]!.reason !== w.reason) return `rules_not_judged row ${i} differs`;
  }
  if ((e.s7_finalized_status ?? '') !== '' && r.s7FinalizedStatus !== e.s7_finalized_status) return `s7_finalized_status "${r.s7FinalizedStatus}", expected "${e.s7_finalized_status}"`;
  if (e.open) {
    const open = openEntries(r);
    if (open.length !== e.open.length) return `${open.length} Open entries, expected ${e.open.length}`;
    for (const [i, o] of open.entries()) {
      const w = e.open[i]!;
      if (o.part !== w.part || o.kind !== w.kind || o.state.code !== w.code || !sameFields(o.state, w.fields)) return `Open entry ${i} is ${o.part}:${o.kind} ${o.state.canonical()}, expected ${w.part}:${w.kind} ${w.code}`;
    }
  }
  return undefined;
}
