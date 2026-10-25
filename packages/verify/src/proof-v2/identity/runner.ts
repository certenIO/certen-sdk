// The skeleton of the composed verifier (twin of env.go Prelude, runner.go earlyReport and vectors.go Inputs.ResolveManifest / RunSet):
// step 0 (manifest + chain row), step 1 (strict decode), and the vector inputs loader. The steps themselves register into a StepRegistry
// (steps.ts); a registry with a missing step is refused at construction, exactly as Go's NewVerifier.
import { sha256 } from '@noble/hashes/sha2';
import { toHex } from './canon.js';
import { decode, defaultIdentityLimits, type Container } from './codec.js';
import { embeddedPin, loadManifest, loadOverride, type Manifest } from './manifest.js';
import { computeHeadline, type Report } from './report.js';
import { StateError } from './states.js';
import { StepRegistry, type StepId } from './steps.js';

/** The leg context as the runner holds it today: the settlement chain and the document the steps read their members from (step 1b / 2a port). */
export interface LegContext { chain: bigint; raw: Record<string, unknown> }
export interface Inputs { ctx: LegContext; container?: Uint8Array; manifestRaw: Uint8Array; manifestPin: string; extensionRaw?: Uint8Array }

export const fixedRulesNotJudgedRows = (): { row: string; reason: string }[] => [];

/** earlyReport: the refused headline of a framework state (nothing else was judged). */
export function earlyReport(ctx: LegContext, m: Manifest, st: StateError): Report {
  return { headline: computeHeadline({ framework: st }), parts: [], chain: ctx.chain, rulesNotJudged: fixedRulesNotJudgedRows(), s7FinalizedStatus: '', manifestSha256: m.sha256, manifestSource: m.source };
}

export interface Prelude { ctx: LegContext; manifest: Manifest; container?: Container }
/** Steps 0 and 1: the chain row of the manifest, then the strict decode. Returns the framework refusal as `refusal`. */
export function prelude(ctx: LegContext, raw: Uint8Array | undefined, m: Manifest): { env?: Prelude; refusal?: StateError } {
  try {
    if (ctx.chain !== 0n) m.chain(ctx.chain);
    const container = raw && raw.length > 0 ? decode(raw, defaultIdentityLimits()) : undefined;
    return { env: { ctx, manifest: m, ...(container ? { container } : {}) } };
  } catch (e) {
    if (e instanceof StateError) return { refusal: e };
    throw e;
  }
}

export type Verifier = (ctx: LegContext, container: Uint8Array | undefined, m: Manifest) => Report;

/** NewVerifier: every registrable step must be registered. The step loop itself is added with the steps (RunSteps, mergeParts). */
export function checkRegistry<F>(reg: StepRegistry<F>): void {
  const miss: StepId[] = reg.missing();
  if (miss.length > 0) throw new Error(`contractidentity: new verifier: ${miss.length} steps have no registered function: ${miss.join(', ')}`);
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
  const chain = f.context['chain'];
  return {
    ctx: { chain: typeof chain === 'string' ? BigInt(chain) : 0n, raw: f.context },
    ...(f.container ? { container: unhexStrict(new TextDecoder().decode(ref(f.container)).trim()) } : {}),
    manifestRaw: ref(f.manifest),
    manifestPin: pin,
    ...(f.extension ? { extensionRaw: ref(f.extension) } : {}),
  };
}
