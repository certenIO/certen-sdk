/**
 * The asynchronous entries of the finality section: the Kinds are registered LAZILY (registerAllKinds loads the Adiri genesis link on first use), so the
 * default wiring cannot happen inside the synchronous verifyProofDocument / verifyPortable. These entries wire the Kinds and the embedded pins first and
 * then call the same synchronous judgement; a wiring failure is a named result (DocumentFinality.wiring), never an exception and never a skipped section.
 *
 * Wiring is needed only when a Settlement is supplied: without one the section judges no level (finality_included_unavailable) and no Kind is consulted.
 */
import type { Report } from '../verify.js';
import { verifyPortable } from '../verify.js';
import { verifyProofDocumentWith, type Verification, type VerifyOptions } from '../../layers.js';
import { registerAllKinds } from './allkinds.js';
import { carriesFinality, judgeFinalityDocument, type DocumentFinality, type FinalityOptions } from './docreport.js';
import { embeddedPins, type Pins } from './pins.js';
import { Registry } from './registry.js';
import { asNamed, hexLower } from './state.js';

const wired = new Map<string, Promise<Registry>>();

/**
 * A Registry holding every ported Kind, registered against `pins` (the embedded pins when absent). The registry is built once per pins file and shared
 * (a Registry is immutable once registered); a refusal rejects with the named state registerAllKinds raised (finality_pins_corrupt for the Adiri genesis
 * link, a registration error otherwise) and is not cached, so a later call tries again.
 */
export async function registerKinds(pins?: Pins | null): Promise<{ registry: Registry; pins: Pins | null }> {
  const p = pins === undefined ? embeddedPins() : pins;
  const key = p === null ? 'none' : `${hexLower(p.sha256)}:${p.source}`;
  let reg = wired.get(key);
  if (reg === undefined) {
    reg = (async () => {
      const r = new Registry();
      await registerAllKinds(r, p);
      return r;
    })();
    wired.set(key, reg);
    reg.catch(() => wired.delete(key));
  }
  return { registry: await reg, pins: p };
}

/** FinalityOptions with the Kinds and pins wired, or the named result of the wiring that failed. */
export async function wireFinalityOptions(opts: FinalityOptions = {}): Promise<{ options: FinalityOptions } | { failure: DocumentFinality }> {
  if (opts.settlement === undefined) return { options: opts };
  const subject = opts.subject ?? 'document';
  try {
    const w = await registerKinds(opts.pins);
    return { options: { ...opts, pins: w.pins, registry: opts.registry ?? w.registry } };
  } catch (e) {
    const st = asNamed(e);
    const message = st !== undefined ? st.toString() : e instanceof Error ? e.message : String(e);
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
