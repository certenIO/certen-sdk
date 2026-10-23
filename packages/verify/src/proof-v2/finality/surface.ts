/**
 * The asynchronous entries of the finality section: the Kinds are registered LAZILY (registerAllKinds loads the Adiri genesis link on first use), so the
 * default wiring cannot happen inside the synchronous verifyProofDocument / verifyPortable. These entries wire the Kinds first and then call the same
 * synchronous judgement; a wiring failure is a named result (DocumentFinality.wiring), never an exception and never a skipped section.
 *
 * Wiring is needed only when a Settlement is supplied: without one the section judges no level (finality_included_unavailable) and no Kind is consulted.
 *
 * As in proofverify (allkinds.Register runs right after EmbeddedPins), the Kinds are registered under the EMBEDDED pins whatever pins the section is judged under:
 * the registration checks the embedded Adiri genesis link against the embedded pins file, and an override pins file (FinalityOptions.pins) only changes what
 * the evidence is judged against.
 */
import type { Report } from '../verify.js';
import { verifyPortable } from '../verify.js';
import { verifyProofDocumentWith, type Verification, type VerifyOptions } from '../../layers.js';
import { registerAllKinds } from './allkinds.js';
import { carriesFinality, judgeFinalityDocument, type DocumentFinality, type FinalityOptions } from './docreport.js';
import { embeddedPins } from './pins.js';
import { Registry } from './registry.js';
import { asNamed } from './state.js';

let defaultKinds: Promise<Registry> | undefined;

/**
 * A Registry holding every ported Kind, registered under the embedded pins. Built once and shared (a Registry is immutable once registered). A refusal rejects
 * with the named state registerAllKinds raised (finality_pins_corrupt for the embedded pins or the Adiri genesis link, a registration error otherwise) and is not
 * remembered, so the next call tries again.
 */
export function registerKinds(): Promise<Registry> {
  if (defaultKinds === undefined) {
    const attempt = (async () => {
      const reg = new Registry();
      await registerAllKinds(reg, embeddedPins());
      return reg;
    })();
    defaultKinds = attempt;
    attempt.catch(() => {
      if (defaultKinds === attempt) defaultKinds = undefined;
    });
  }
  return defaultKinds;
}

/** FinalityOptions with the Kinds wired, or the named result of the wiring that failed. Nothing is wired when no Settlement is supplied (nothing would be judged). */
export async function wireFinalityOptions(opts: FinalityOptions = {}): Promise<{ options: FinalityOptions } | { failure: DocumentFinality }> {
  if (opts.settlement === undefined || opts.registry !== undefined) return { options: opts };
  try {
    return { options: { ...opts, registry: await registerKinds() } };
  } catch (e) {
    const st = asNamed(e);
    const message = st !== undefined ? st.toString() : e instanceof Error ? e.message : String(e);
    const subject = opts.subject ?? 'document';
    return {
      failure: Object.defineProperties(
        { class: 'failed', exit: 1, text: `FAILED (finality)  ${subject}\n  the verifier cannot be wired: its Kinds do not register: ${message}\n` } as DocumentFinality,
        {
          ...(st !== undefined ? { state: { value: st, enumerable: false } } : {}),
          wiring: { value: { stage: 'kinds', ...(st !== undefined ? { state: st } : {}), message }, enumerable: false },
        },
      ),
    };
  }
}

/** judgeFinalityDocument with the Kinds registered first (see the header). */
export async function judgeFinalityDocumentWithKinds(document: unknown, opts: FinalityOptions = {}): Promise<DocumentFinality> {
  const w = await wireFinalityOptions(opts);
  return 'failure' in w ? w.failure : judgeFinalityDocument(document, w.options);
}

/** verifyProofDocument with the finality section judged by every ported Kind: the asynchronous twin that wires the Kinds (see the header). */
export async function verifyProofDocumentWithKinds(doc: unknown, opts: VerifyOptions = {}): Promise<Verification> {
  if (opts.finality === undefined && !carriesFinality(doc)) return verifyProofDocumentWith(doc, opts, undefined);
  const w = await wireFinalityOptions(opts.finality ?? {});
  const fin = 'failure' in w ? w.failure : judgeFinalityDocument(doc, w.options);
  return verifyProofDocumentWith(doc, opts, fin);
}

/** verifyPortable with the finality section judged by every ported Kind. Throws what verifyPortable throws; the section itself never throws. */
export async function verifyPortableWithKinds(document: unknown, trace?: Parameters<typeof verifyPortable>[1], opts: { finality?: FinalityOptions } = {}): Promise<Report> {
  if (opts.finality === undefined && !carriesFinality(document)) return verifyPortable(document, trace);
  const w = await wireFinalityOptions(opts.finality ?? {});
  if ('failure' in w) {
    const report = verifyPortable(document, trace);
    report.finality = w.failure;
    return report;
  }
  return verifyPortable(document, trace, { finality: w.options });
}
