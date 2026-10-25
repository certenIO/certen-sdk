// The library entry of the contract-identity verifier (S8): one synchronous call from the portable evidence (the container bytes, optionally an
// override manifest and an extension, and the leg context built from S6 + S7 + the proof file) to the report. The production verifier registers
// every step of every package; there is no stand-in and no fallback: what cannot be established is a named state in the report.
import { StateError } from './states.js';
import type { LegContext } from './context.js';
import { earlyReport, newVerifier, resolveManifest, type Verifier } from './runner.js';
import type { Report } from './report.js';
import { StepRegistry } from './steps.js';
import { registerAllSteps } from './steps2b_all.js';
import type { StepFn } from './framework.js';

let production: Verifier | undefined;
/** The verifier over the complete step table (NewDefaultVerifier). */
export function productionVerifier(): Verifier {
  if (!production) {
    const reg = new StepRegistry<StepFn>();
    registerAllSteps(reg);
    production = newVerifier(reg);
  }
  return production;
}

export interface ManifestInput {
  /** The manifest document bytes. Omitted: the embedded, pinned manifest. */
  raw?: Uint8Array;
  /** The sha256 (64 lower-case hex digits) the document must have; omitted: the embedded pin, so altered bytes are manifest_corrupt. A modified document is loaded by passing the hash of its bytes (source override:<sha256>). */
  pin?: string;
}

/**
 * verifyContractIdentity: step 0 (manifest against its pin, then the extension under the no-shadow rule) and then the composed verifier. A manifest or
 * extension the verifier refuses to start from is the refused headline of that framework state (the verifier is not reached). The headline kinds are
 * refused, pending, unproven, verified_core and verified; verified_core is never a verified.
 */
export function verifyContractIdentity(container: Uint8Array | undefined, manifest: ManifestInput | undefined, extension: Uint8Array | undefined, ctx: LegContext): Report {
  const r = resolveManifest({ ctx, ...(container ? { container } : {}), manifestRaw: manifest?.raw ?? embeddedBytes(), manifestPin: manifest?.pin ?? pinOf(), ...(extension ? { extensionRaw: extension } : {}) });
  if (r.refusal) return earlyReport(ctx, placeholder(manifest), r.refusal);
  return productionVerifier()(ctx, container, r.manifest!);
}
import { embeddedManifestBytes, embeddedPin, Manifest, manifestHash } from './manifest.js';
const embeddedBytes = (): Uint8Array => embeddedManifestBytes();
const pinOf = (): string => embeddedPin();
/** The manifest identity a framework refusal of step 0 reports: the hash of the bytes that were offered. */
function placeholder(manifest: ManifestInput | undefined): Manifest {
  const raw = manifest?.raw ?? embeddedBytes();
  const sha = manifestHash(raw);
  return new Manifest({}, sha, sha === embeddedPin() ? 'embedded' : 'override:' + sha);
}
export { StateError };
