export { verifyPortable, computeIncarnation, PORTABLE_FORMAT, VERSION } from './proof-v2/verify.js';
export type { Report, SetVerdict, PageChain } from './proof-v2/verify.js';
export { VerifyError } from './proof-v2/bytes.js';
export { accumulateSetRoot } from './proof-v2/accset.js';
export type { AccumulateValidator, Threshold } from './proof-v2/accset.js';
export {
  govRootV3,
  govRootV3FromPortable,
  pagesRootV3,
  computeGovRootV3,
  govRootV3SlotHash,
  canonicalAccSpelling,
  hashUrlString,
  GOVROOT_V3_DOMAIN,
  GOVROOT_V3_TAGS,
  G1_HISTORICAL_UNAVAILABLE,
} from './proof-v2/govroot-v3.js';
export type { GovRootV3, GovRootV3Inputs, GovRootV3Slots } from './proof-v2/govroot-v3.js';
export { verifyProofDocument, noEvidence, COVERED_STATEMENTS, NOT_COVERED_STATEMENTS } from './layers.js';
export type { Layer, LayerVerdict, Overall, Verification, VerifyOptions } from './layers.js';
