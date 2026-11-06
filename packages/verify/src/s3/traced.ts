/**
 * verifyPortableAny for a document of evidence 2.1, reporting each stage as it completes (Trace21) so a per-layer report (layers.ts) can name the layer a refusal
 * belongs to. The same decoding and the same refusals as verifyPortableAny (s3/index.ts): the trace observes the walk and changes no verdict. Internal to the
 * package: the public entries are verifyPortableAny and verifyProofDocument.
 */
import { VerifyError } from '../proof-v2/bytes.js';
import { WireError } from '../sigtypes/wire.js';
import { decodePortable } from './gotree.js';
import { verifyPortable21, type Trace21 } from './portable21.js';
import type { Report21 } from './xtypes.js';

export function verifyPortable21Traced(document: unknown, trace: Trace21): Report21 {
  const text = JSON.stringify(document);
  if (text === undefined) throw new VerifyError('portable proof is not JSON');
  try {
    return verifyPortable21(decodePortable(text), trace);
  } catch (e) {
    // Bytes that are not an Accumulate value are a value Go's decoder refuses: a plain refusal of the document, never a defect of the verifier.
    if (e instanceof WireError) throw new VerifyError(`undecodable: ${e.message}`);
    throw e;
  }
}
