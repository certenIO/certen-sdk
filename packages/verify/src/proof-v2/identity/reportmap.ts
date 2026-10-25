// The canonical object of a report (twin of report.go Report.Validate / Map / Canonical and types.go Headline.State): what a consumer prints or
// compares. Keys sorted, integers decimal strings, bytes 0x hex; `verified_core` stays its own headline and is never printed as `verified`.
import { canonical, type CanonValue } from './canon.js';
import * as N from './names.js';
import { JudgedParts, openEntries, sortOpen, type Finding, type Headline, type Report } from './report.js';
import { defaultVocabulary, must, validateState, type StateError } from './states.js';

type Obj = { [k: string]: CanonValue };
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const stateObj = (s: StateError): Obj => ({ code: s.code, fields: s.fields as Obj });
const openObj = (o: { part: string; kind: string; state: StateError }): Obj => ({ part: o.part, kind: o.kind, code: o.state.code, fields: o.state.fields as Obj });
function findingObjects(f: Finding[]): CanonValue[] {
  return [...f].sort((a, b) => cmp(a.part, b.part) || cmp(a.state!.code, b.state!.code) || cmp(canonical(a.state!.fields as Obj), canonical(b.state!.fields as Obj)))
    .map((x) => ({ part: x.part, code: x.state!.code, fields: x.state!.fields as Obj }));
}

/** Headline.State: the named state that carries the headline (refused, unproven, pending, verified_core, verified, or the not_applicable state). */
export function headlineState(h: Headline): StateError {
  switch (h.kind) {
    case N.HeadlineRefused:
      if (!h.first) throw new Error('contractidentity: refused headline without its first refusal');
      return must(N.CodeRefused, '', { first: stateObj(h.first), parts: h.parts });
    case N.HeadlineUnproven: return must(N.CodeUnproven, '(wrapper)', { parts: h.parts });
    case N.HeadlinePending: {
      const f: Obj = { level_reached: h.levelReached ?? '', next_level: 'finalized' };
      if (h.findings && h.findings.length > 0) f['findings'] = findingObjects(h.findings);
      if (h.s7FinalizedStatus) f['s7_finalized_status'] = h.s7FinalizedStatus;
      return must(N.CodePending, N.RowPendingStateRootNotAuthenticated, f);
    }
    case N.HeadlineVerifiedCore: return must(N.CodeVerifiedCore, '', { open: sortOpen([...(h.open ?? [])]).map(openObj) });
    case N.HeadlineVerified: return must(N.CodeVerified, '', { judged_at_level: h.judgedAtLevel ?? '', stateRoot: h.stateRoot ?? new Uint8Array(32), block: h.block ?? 0n, registry_link: h.registryLink ?? '' });
    case N.HeadlineNotApplicable:
      if (!h.notApplicable) throw new Error('contractidentity: not_applicable headline without its state');
      return h.notApplicable;
    default: throw new Error('contractidentity: headline kind "' + h.kind + '"');
  }
}

/** Report.Validate: the headline has a state, every part is judged once and every state is a registry state, the residuals are the fixed set. */
export function validateReport(r: Report): void {
  headlineState(r.headline);
  const seen = new Set<string>();
  for (const p of r.parts) {
    if (!JudgedParts.includes(p.part) || seen.has(p.part)) throw new Error('contractidentity: report: part "' + p.part + '" unknown or repeated');
    seen.add(p.part);
    if (p.state) validateState(p.state);
  }
  const want = [N.ResidualRPKC, N.ResidualRINNER, N.ResidualRSETTLEPOINTER, N.ResidualRWRITERS].sort();
  if ([...r.residuals].sort().join() !== want.join()) throw new Error('contractidentity: report: residuals ' + r.residuals.join() + ', the fixed set is ' + want.join());
  const v = defaultVocabulary();
  for (const id of r.rulesJudged) if (!v.check('rule_id', id) && !v.check('settlement_rule_id', id)) throw new Error('contractidentity: report: rules_judged id "' + id + '" outside the vocabulary');
  if (r.manifestSource !== undefined && !v.check('manifest_source', r.manifestSource)) throw new Error('contractidentity: report: manifest_source "' + r.manifestSource + '"');
}

/** Report.Map: the canonical object (a CanonValue tree; canonical(reportObject(r)) is the byte form two verifiers compare). */
export function reportObject(r: Report): Obj {
  validateReport(r);
  const hs = headlineState(r.headline);
  const parts = [...r.parts].sort((a, b) => cmp(a.part, b.part)).map((p): Obj => {
    const o: Obj = { part: p.part, status: p.status };
    if (p.state) o['state'] = stateObj(p.state);
    if (p.reason) o['reason'] = p.reason;
    return o;
  });
  const out: Obj = {
    headline: { code: hs.code, fields: hs.fields as Obj }, parts, open: openEntries(r).map(openObj),
    rules_judged: [...r.rulesJudged].sort(), residuals: [...r.residuals].sort(),
    rules_not_judged: [...r.rulesNotJudged].sort((a, b) => cmp(a.row, b.row) || cmp(a.reason, b.reason)).map((x): Obj => ({ row: x.row, reason: x.reason })),
  };
  if (r.headline.kind === N.HeadlinePending && r.headline.findings && r.headline.findings.length > 0) out['findings'] = findingObjects(r.headline.findings);
  if (r.registry) out['registry'] = r.registry;
  if (r.authority) {
    const a = r.authority;
    out['authority'] = { level: a.level, logged_level: a.loggedLevel, book: a.book, page: a.page, source: a.source, legs: a.legs.map((l): Obj => ({ target: l.target, selector: l.selector, value: l.value, required: l.required })) };
  }
  if (r.s6) out['s6'] = { ...r.s6 } as Obj;
  out['judged_at_level'] = r.judgedAtLevel;
  out['state_root_authenticated'] = r.stateRootAuthenticated;
  out['s7_finalized_status'] = r.s7FinalizedStatus;
  out['chain'] = r.chain ?? 0n;
  out['block'] = r.block;
  out['block_hash'] = r.blockHash;
  out['manifest_sha256'] = '0x' + (r.manifestSha256 ?? '');
  out['manifest_source'] = r.manifestSource ?? '';
  return out;
}
export const canonicalReport = (r: Report): string => canonical(reportObject(r));
