/**
 * The SDK's default entry (Node): everything in the browser-safe surface, plus the two parts that need Node.
 * See browser.ts for the portable half and why the split exists.
 */
export * from './browser.js';

// Standalone on purpose: redeeming a share link needs no API key and therefore no client. Node-only because a shared bundle may be
// gzipped (node:zlib). See shared-proof.ts.
export { fetchSharedProof, decodeSharedBundle } from './shared-proof.js';

// An autonomous agent's identity and every proof-gated verb it needs, composed once. Node-only: it holds and uses a local ed25519 key
// through node:crypto. See agent.ts.
export { CertenAgent, ed25519Signer } from './agent.js';
export type { AgentSigner, CertenAgentState, ProvisionParams } from './agent.js';
