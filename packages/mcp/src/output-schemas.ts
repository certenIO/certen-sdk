import { GENERATED_OUTPUT_SCHEMAS } from './output-schemas.generated.js';

/**
 * `outputSchema` for every tool.
 *
 * Most schemas are GENERATED (output-schemas.generated.ts, by `npm run agentgen`) from the gateway's own response schemas, because most
 * tools return the gateway's body unchanged. The tools below build their own result, so their schemas are written here, next to nothing
 * else: `packages/mcp/test/structured-output.test.ts` runs every one of these tools and validates what it really returns against its
 * schema, and a generator check (`tools/agentgen/emit/mcp-output-schemas.mjs` CUSTOM_TOOLS) fails if this list and that one disagree.
 *
 * A server that declares an `outputSchema` MUST return structured results that conform to it (MCP 2026-07-28, Tools).
 */

type Schema = Record<string, unknown>;

const str: Schema = { type: 'string' };
const bool: Schema = { type: 'boolean' };
const strOrNull: Schema = { type: ['string', 'null'] };

const checkSchema: Schema = {
  type: 'object',
  properties: {
    name: str,
    status: { type: 'string', enum: ['ok', 'failed', 'skipped'] },
    detail: str,
  },
  required: ['name', 'status', 'detail'],
  additionalProperties: false,
};

/** Reduced from the gateway's own balance schema, so the types cannot drift from it. */
function fromBalance(...keys: string[]): Schema {
  const balance = GENERATED_OUTPUT_SCHEMAS.certen_billing_balance as { properties?: Record<string, Schema> };
  const out: Record<string, Schema> = {};
  for (const k of keys) out[k] = balance.properties?.[k] ?? {};
  return out;
}

export const CUSTOM_OUTPUT_SCHEMAS: Readonly<Record<string, Schema>> = {
  // The gateway answers 204 with no body; the SDK returns { success: true } (a failure throws).
  certen_admin_revoke_api_key: {
    type: 'object',
    properties: { success: { type: 'boolean', enum: [true] } },
    required: ['success'],
    additionalProperties: false,
  },

  // ReceiptVerification (packages/sdk/src/types.ts): verified only when EVERY check is ok; complete says none were skipped.
  certen_billing_verify_receipt: {
    type: 'object',
    properties: { receipt_id: str, verified: bool, complete: bool, checks: { type: 'array', items: checkSchema } },
    required: ['receipt_id', 'verified', 'complete', 'checks'],
    additionalProperties: false,
  },

  // enabledChainReport() in chains.ts.
  certen_chains_enabled: {
    type: 'object',
    properties: {
      enabled: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            slug: str, chainId: { type: 'integer' }, displayName: str, environment: str, support: { type: 'string', enum: ['live', 'opt-in'] },
            nativeSymbol: str, faucet: strOrNull, blocksOnlyWithTraffic: bool,
          },
          required: ['slug', 'chainId', 'displayName', 'environment', 'support', 'nativeSymbol', 'faucet', 'blocksOnlyWithTraffic'],
          additionalProperties: false,
        },
      },
      configured: { type: 'array', items: str },
      defaultSet: { type: 'array', items: str },
      optIn: {
        type: 'array',
        items: {
          type: 'object',
          properties: { slug: str, enabled: bool, servedByGateway: bool, howToEnable: strOrNull },
          required: ['slug', 'enabled', 'howToEnable'],
          additionalProperties: false,
        },
      },
      note: str,
    },
    required: ['enabled', 'configured', 'defaultSet', 'optIn', 'note'],
    additionalProperties: false,
  },

  // DoctorReport (packages/sdk/src/doctor.ts).
  certen_doctor: {
    type: 'object',
    properties: {
      ok: bool,
      unreachable: bool,
      checks: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: str, status: { type: 'string', enum: ['ok', 'warn', 'fail', 'skipped'] }, detail: str, fix: str },
          required: ['name', 'status', 'detail'],
          additionalProperties: false,
        },
      },
    },
    required: ['ok', 'unreachable', 'checks'],
    additionalProperties: false,
  },

  // With wait:false the gateway's 202 (no documented body); with wait:true the identity once it can sign. Both are objects.
  certen_identity_create: {
    type: 'object',
    description: 'The 202 body from the gateway (wait:false) or the identity once it can sign (wait:true).',
    additionalProperties: true,
  },

  // execute.proof(): a CERTEN proof, or the Accumulate receipt when the intent has no cross-chain proof id.
  certen_proof_get: {
    type: 'object',
    oneOf: [
      {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['certen-proof'] }, proofId: str, proof: {}, intent: { type: 'object', additionalProperties: true } },
        required: ['kind', 'proofId', 'proof', 'intent'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['accumulate-receipt'] }, txHash: str, receipt: {}, intent: { type: 'object', additionalProperties: true } },
        required: ['kind', 'txHash', 'receipt', 'intent'],
        additionalProperties: false,
      },
    ],
  },

  // The per-layer verification (verifyBundle in @certen.io/sdk/verify): one verdict per layer, the statements covered, and the
  // evidence found. Closed, so a field added to the SDK result that the schema does not know fails the structured-output test.
  certen_proof_verify: {
    type: 'object',
    properties: {
      overall: { type: 'string', enum: ['verified', 'partial', 'failed', 'no_evidence'] },
      independent: bool,
      layers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: str,
            statement: str,
            title: str,
            verdict: { type: 'string', enum: ['verified', 'failed', 'not_checked', 'not_in_document'] },
            evidence: { type: 'object', additionalProperties: true },
            reason: str,
          },
          required: ['id', 'statement', 'title', 'verdict', 'evidence'],
          additionalProperties: false,
        },
      },
      covers: { type: 'array', items: str },
      notCovered: { type: 'array', items: str },
      failure: { type: 'object', properties: { layer: str, message: str }, required: ['layer', 'message'], additionalProperties: false },
      govRootV3: str,
      execution: { type: ['object', 'null'], additionalProperties: true },
      headerCheck: { type: ['object', 'null'], additionalProperties: true },
      bundleStatements: { type: 'object', additionalProperties: true },
      evidenceFound: bool,
      evidence: { type: 'object', properties: { found: bool, code: str, reason: str, bundleError: str }, required: ['found'], additionalProperties: false },
      gateway: { type: ['object', 'null'], additionalProperties: true },
    },
    required: ['overall', 'independent', 'layers', 'covers', 'notCovered', 'execution', 'headerCheck', 'bundleStatements', 'evidenceFound', 'evidence', 'gateway'],
    additionalProperties: false,
  },

  // A reduced view of the balance; the money fields take their types from the gateway's balance schema.
  certen_whoami: {
    type: 'object',
    properties: {
      account_status: (GENERATED_OUTPUT_SCHEMAS.certen_billing_balance as { properties?: Record<string, Schema> }).properties?.status ?? {},
      ...fromBalance('spendable_usd', 'available_usd', 'held_usd'),
      credit: { type: ['object', 'null'], additionalProperties: true },
      suspended_reason: strOrNull,
      organization: str,
    },
    required: ['account_status', 'credit', 'suspended_reason', 'organization'],
    additionalProperties: false,
  },
};

/** The `outputSchema` of a tool, or undefined for a name that has none. */
export function outputSchemaFor(toolName: string): Schema | undefined {
  return CUSTOM_OUTPUT_SCHEMAS[toolName] ?? (GENERATED_OUTPUT_SCHEMAS[toolName] as Schema | undefined);
}
