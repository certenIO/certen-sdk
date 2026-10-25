// The composed verifier (twin of env.go Prelude, runner.go RunSteps / mergeParts / buildReport, verify.go and vectors.go ResolveManifest):
// step 0 (manifest + chain row), step 1 (strict decode), 1b (context), then the registered steps in execution order, the node accounting
// (22b) and the report. A registry with a missing step is refused at construction; a step that returns a defect is an Error, never a verdict.
import { sha256 } from '@noble/hashes/sha2';
import { toHex } from './canon.js';
import { decode } from './codec.js';
import { contextFromFile, validateContext, type LegContext } from './context.js';
import { factGroups, fingerprint, newEnv, type Env, type StepFn, type StepOutput } from './framework.js';
import { embeddedPin, loadManifest, loadOverride, type Manifest } from './manifest.js';
import * as N from './names.js';
import { NodeSet } from './reads.js';
import { computeHeadline, isCoreJudgedPart, JudgedParts, sortOpen, type OpenEntry, type PartResult, type Report, type RuleNotJudged } from './report.js';
import { malformed, must, StateError } from './states.js';
import { execOrder, spec, stepTable, type StepId, type StepRegistry } from './steps.js';

export type { LegContext };
export interface Inputs { ctx: LegContext; container?: Uint8Array; manifestRaw: Uint8Array; manifestPin: string; extensionRaw?: Uint8Array }

export const fixedRulesNotJudged = (): RuleNotJudged[] => [
  { row: 'A21', reason: 'minimumGovernanceLevelForValueOps is read only by executeWithGovernance (CertenAnchorV8_2.sol:1398), not on the attestation path; reported in registry' },
  { row: 'A09:3', reason: 'registeredAt is informational; no acceptance decision reads it' },
  { row: 'slot19:usedNonces', reason: 'restrict-only: its single reader is nonceValid = !usedNonces[...] (CertenAnchorV8_2.sol:2002) and its single writer assigns the literal true (:1352)' },
  { row: 'slot28:operators', reason: 'not read by the attestation path' },
];

/** earlyReport: the refused headline of a framework state (nothing else was judged). */
export function earlyReport(ctx: LegContext, m: Manifest, st: StateError): Report {
  return { headline: computeHeadline({ framework: st }), parts: [], chain: ctx.chain, rulesNotJudged: fixedRulesNotJudged(), s7FinalizedStatus: '', manifestSha256: m.sha256, manifestSource: m.source };
}

/** Steps 0, 1 and 1b: the chain row, the strict decode, the context, the node set. Returns the env or the framework refusal. */
export function prelude(ctx: LegContext, raw: Uint8Array | undefined, m: Manifest): { env?: Env; refusal?: StateError } {
  const env = newEnv(ctx, raw, m);
  try {
    if (ctx.chain !== 0n) env.chain = m.chain(ctx.chain);
    if (raw && raw.length > 0) env.container = decode(raw, env.limits);
    const bad = validateContext(ctx);
    if (bad) return { refusal: bad };
    if (env.container) env.nodes = new NodeSet(env.container.nodes);
    return { env };
  } catch (e) {
    if (e instanceof StateError) return { refusal: e };
    throw e;
  }
}

export type Verifier = (ctx: LegContext, container: Uint8Array | undefined, m: Manifest) => Report;

const specPos = (id: StepId): number => stepTable.findIndex((s) => s.id === id);
interface Contribution { step: StepId; p: PartResult }
interface RunResult { parts: PartResult[]; framework?: StateError; rulesJudged: string[]; executed: StepId[] }

function validateOutput(id: StepId, out: StepOutput): void {
  const bad = (m: string): never => { throw new Error(`contractidentity: step ${id} output: ${m}`); };
  if (out.supersede && id !== '24') bad('only step 24 may supersede the part table');
  const seen = new Set<string>();
  for (const p of out.parts ?? []) {
    if (!JudgedParts.includes(p.part)) bad(`unknown part "${p.part}"`);
    if (p.status === 'open') bad(`part ${p.part} has the status open: the runner derives it from the Open entries`);
    if (seen.has(p.part)) bad(`part ${p.part} reported twice`);
    seen.add(p.part);
    if ((p.status === 'refused' || p.status === 'unproven') && !p.state) bad(`${p.status} part ${p.part} has no state`);
    if (p.status === 'verified' && p.state) bad(`verified part ${p.part} carries a state`);
  }
  for (const o of out.open ?? []) if (!JudgedParts.includes(o.part)) bad(`Open entry on unknown part "${o.part}"`);
}

function mergeParts(contribs: Contribution[], opens: OpenEntry[], executed: Set<StepId>, registry9: boolean, allowUndecided: boolean): PartResult[] {
  const out: PartResult[] = [];
  for (const part of JudgedParts) {
    const cs = contribs.filter((c) => c.p.part === part).sort((a, b) => specPos(a.step) - specPos(b.step));
    const entries = [...cs.flatMap((c) => c.p.open ?? []), ...opens.filter((o) => o.part === part)];
    const decisive = cs.find((c) => c.p.status !== 'verified');
    let res: PartResult;
    if (decisive) res = { ...decisive.p };
    else {
      for (const s of stepTable) {
        if (!executed.has(s.id) || !s.parts.includes(part)) continue;
        if (!cs.some((c) => c.step === s.id)) throw new Error(`contractidentity: part ${part} is undecided: declared contributor ${s.id} reported nothing and no step refused the part`);
      }
      if (cs.length === 0) {
        if (allowUndecided) continue;
        throw new Error(`contractidentity: part ${part} is undecided: no step reported it`);
      }
      res = { part, status: 'verified' };
      if (entries.length > 0 && !isCoreJudgedPart(part, registry9)) res.status = 'open';
    }
    delete res.open;
    if (entries.length > 0) res.open = sortOpen([...entries]);
    out.push(res);
  }
  return out;
}

function runSteps(env: Env, reg: StepRegistry<StepFn>): RunResult {
  if (!env.container) {
    const st = must(N.CodeUnproven, N.RowUnprovenNoEvidenceInFile, { part: N.UnprovenPartAll });
    return { parts: JudgedParts.map((part) => ({ part, status: 'unproven' as const, state: st })), rulesJudged: [], executed: [] };
  }
  const contribs: Contribution[] = [];
  const opens: OpenEntry[] = [];
  const judged = new Set<string>();
  const executed = new Set<StepId>();
  const incomplete: string[] = [];
  let framework: StateError | undefined;
  let halted: { step: StepId; framework: boolean } | undefined;
  for (const id of execOrder) {
    if (halted) continue;
    if (id === '22b') {
      if (env.nodes && incomplete.length === 0) {
        const un = env.nodes.unvisited();
        if (un.length > 0 && !framework) framework = malformed(N.PartNodes, N.MalformedNodesUnreferenced, un[0]!, 0, 0);
      }
      executed.add(id);
      continue;
    }
    const sp = spec(id)!;
    const before = new Map(factGroups.map((g) => [g.name, fingerprint(env.facts[g.name])] as const));
    const out = reg.get(id)!(env);
    for (const g of factGroups) if (before.get(g.name) !== fingerprint(env.facts[g.name]) && g.owner !== sp.owner) throw new Error(`contractidentity: step ${id} (package ${sp.owner}) wrote the facts of group ${g.name}`);
    executed.add(id);
    validateOutput(id, out);
    for (const p of out.parts ?? []) contribs.push({ step: id, p });
    opens.push(...(out.open ?? []));
    for (const r of out.rulesJudged ?? []) judged.add(r);
    if (out.readPlanIncomplete) incomplete.push(`${id}:${out.readPlanIncomplete}`);
    if (out.framework) { framework ??= out.framework; halted = { step: id, framework: true }; } else if (out.halt) halted = { step: id, framework: false };
  }
  if (halted?.framework) executed.delete(halted.step);
  const parts = mergeParts(contribs, opens, executed, env.ctx.registry9 !== undefined, !!halted?.framework);
  return { parts, ...(framework ? { framework } : {}), rulesJudged: [...judged].sort(), executed: [...executed] };
}

function buildReport(env: Env, res: RunResult): Report {
  const f = env.facts;
  const headline = computeHeadline({
    parts: res.parts, ...(res.framework ? { framework: res.framework } : {}), registry9: env.ctx.registry9 !== undefined, stateRootAuthenticated: f.C.level.authenticated,
    levelReached: f.C.level.judgedAtLevel, s7FinalizedStatus: f.C.level.s7FinalizedStatus, judgedAtLevel: f.C.level.judgedAtLevel, stateRoot: f.A.stateRootN, block: env.container?.leg.number ?? 0n, registryLink: f.C.registryLink,
  });
  const ran23 = res.executed.includes('23');
  if (ran23 && f.C.rulesNotJudged.length === 0) throw new Error('contractidentity: report: step 23 ran and wrote no rules_not_judged (every outcome prints them)');
  return {
    headline, parts: res.parts, chain: env.ctx.chain, rulesNotJudged: ran23 ? f.C.rulesNotJudged : fixedRulesNotJudged(), s7FinalizedStatus: f.C.level.s7FinalizedStatus,
    ...(f.C.registry ? { registry: f.C.registry } : {}), manifestSha256: env.manifest.sha256, manifestSource: env.manifest.source,
  };
}

/** NewVerifier: every registrable step must be registered; the returned function is the composed verifier. */
export function newVerifier(reg: StepRegistry<StepFn>): Verifier {
  const miss = reg.missing();
  if (miss.length > 0) throw new Error(`contractidentity: new verifier: ${miss.length} steps have no registered function: ${miss.join(', ')}`);
  return (ctx, container, m) => {
    const p = prelude(ctx, container, m);
    if (p.refusal) return earlyReport(ctx, m, p.refusal);
    return buildReport(p.env!, runSteps(p.env!, reg));
  };
}

/** Inputs.ResolveManifest: the manifest against its pin (an override when it is not the embedded one), then the extension. */
export function resolveManifest(inp: Inputs): { manifest?: Manifest; refusal?: StateError } {
  try {
    let m = loadManifest(inp.manifestRaw, inp.manifestPin);
    if (m.sha256 !== embeddedPin()) m = loadOverride(inp.manifestRaw);
    if (inp.extensionRaw) throw new Error('contractidentity: a manifest extension is merged by the extension port (WithExtension), which this package does not carry yet');
    return { manifest: m };
  } catch (e) {
    if (e instanceof StateError) return { refusal: e };
    throw e;
  }
}

// ---- the materialised vector inputs (FORMAT.md, "Materialised vectors") ----

interface FileRef { file: string; sha256: string }
interface InputsFile { format: string; id: string; container: FileRef | null; manifest: FileRef & { pin: string }; extension: FileRef | null; context: Record<string, unknown> }
const unhexStrict = (s: string): Uint8Array => {
  if (!/^([0-9a-f]{2})*$/.test(s)) throw new Error('contractidentity: inputs: not lower-case hex');
  return Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
};

/** LoadMaterialised: every referenced file must hash to the sha256 the inputs file names. `files` maps a file name of the set to its bytes. */
export function loadMaterialised(inputsJson: string, files: ReadonlyMap<string, Uint8Array>): Inputs {
  const f = JSON.parse(inputsJson) as InputsFile;
  if (f.format !== 'certen-contract-identity-inputs/1') throw new Error(`inputs file ${f.id}: format ${f.format}`);
  const ref = (r: FileRef): Uint8Array => {
    const b = files.get(r.file);
    if (!b) throw new Error(`inputs file ${f.id}: referenced file ${r.file} is not in the set`);
    if (toHex(sha256(b)) !== r.sha256) throw new Error(`inputs file ${f.id}: file ${r.file} does not hash to ${r.sha256}`);
    return b;
  };
  if (!f.manifest) throw new Error(`inputs file ${f.id}: no manifest reference`);
  const pin = f.manifest.pin.startsWith('0x') ? f.manifest.pin.slice(2) : f.manifest.pin;
  if (!/^[0-9a-f]{64}$/.test(pin)) throw new Error(`inputs file ${f.id}: manifest pin`);
  return {
    ctx: contextFromFile(f.context),
    ...(f.container ? { container: unhexStrict(new TextDecoder().decode(ref(f.container)).trim()) } : {}),
    manifestRaw: ref(f.manifest),
    manifestPin: pin,
    ...(f.extension ? { extensionRaw: ref(f.extension) } : {}),
  };
}
