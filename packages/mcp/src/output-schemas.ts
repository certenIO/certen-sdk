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

/** One readiness check (ReadinessCheck in packages/sdk/src/readiness.ts). */
const readinessCheck: Schema = {
  type: 'object',
  properties: {
    name: str,
    status: { type: 'string', enum: ['ok', 'warn', 'fail', 'unknown', 'skipped'] },
    detail: str,
    code: str,
    fix: {
      type: 'object',
      properties: { text: str, command: str, url: str },
      required: ['text'],
      additionalProperties: false,
    },
    data: { type: 'object', additionalProperties: true },
  },
  required: ['name', 'status', 'detail'],
  additionalProperties: false,
};

/** What intentOutcome() names (packages/sdk/src/intent-states.ts); the same two lists the generator's INTENT_OUTCOME_SCHEMA pins. */
const INTENT_CLASSES = ['in_flight', 'executed', 'terminal_success', 'terminal_gas_only', 'terminal_failure', 'unknown'];
const INTENT_OUTCOMES = ['completed', 'completed_unproven', 'executed', 'failed', 'pending', 'unknown'];

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

  // Readiness (packages/sdk/src/readiness.ts). Closed at the top and in each check, so a field added to the SDK result fails the structured-output
  // test until this says what it is; `data` is open on purpose (the SDK documents it as open: fields are only ever added).
  certen_readiness: {
    type: 'object',
    properties: {
      ready: bool,
      state: { type: 'string', enum: ['ready', 'blocked', 'unconfirmed'] },
      first_blocker: { anyOf: [readinessCheck, { type: 'null' }] },
      checks: { type: 'array', items: readinessCheck },
      context: {
        type: 'object',
        properties: {
          identity_id: str, adi_url: strOrNull, key_page_url: strOrNull, chain: str,
          abstract_account: strOrNull, accumulate_rpc: strOrNull, key_hash: strOrNull,
        },
        required: ['identity_id', 'adi_url', 'key_page_url', 'chain', 'abstract_account', 'accumulate_rpc', 'key_hash'],
        additionalProperties: false,
      },
    },
    required: ['ready', 'state', 'first_blocker', 'checks', 'context'],
    additionalProperties: false,
  },

  // The receipt (packages/sdk/src/receipt.ts), the same document `certen receipt --json` returns (docs/CLI-CONTRACT.md section 10). Closed at the top
  // and in each named block; `request`, `signed_with`, `recipient_snapshot` and the per-layer `evidence` are open objects the SDK documents as such.
  certen_receipt: {
    type: 'object',
    properties: {
      receipt_version: { type: 'integer', enum: [1] },
      intent_id: str,
      kind: { type: 'string', enum: ['transfer', 'contract_call', 'intent', 'unknown'] },
      created_at: str,
      updated_at: str,
      gateway: strOrNull,
      request: { type: ['object', 'null'], additionalProperties: true },
      signed_with: { type: ['object', 'null'], additionalProperties: true },
      status: {
        type: 'object',
        properties: {
          gateway_status: str,
          class: { type: 'string', enum: INTENT_CLASSES },
          outcome: { type: 'string', enum: INTENT_OUTCOMES },
          terminal: bool,
          reason_code: strOrNull, reason: strOrNull, completion_basis: strOrNull, validator_state: strOrNull,
        },
        required: ['gateway_status', 'class', 'outcome', 'terminal', 'reason_code', 'reason', 'completion_basis', 'validator_state'],
        additionalProperties: false,
      },
      ids: {
        type: 'object',
        properties: {
          intent_id: str, accumulate_tx: strOrNull, accumulate_tx_hash: strOrNull, destination_tx: strOrNull,
          destination_tx_source: { type: ['string', 'null'], enum: ['proof', 'validators', null] },
          destination_chain: strOrNull, destination_block: { type: ['integer', 'null'] }, proof_id: strOrNull, write_back_tx: strOrNull,
        },
        required: ['intent_id', 'accumulate_tx', 'accumulate_tx_hash', 'destination_tx', 'destination_tx_source', 'destination_chain', 'destination_block', 'proof_id', 'write_back_tx'],
        additionalProperties: false,
      },
      links: {
        type: 'object',
        properties: { destination_tx: strOrNull, accumulate_explorer: strOrNull },
        required: ['destination_tx', 'accumulate_explorer'],
        additionalProperties: false,
      },
      stages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', enum: ['signed', 'anchored', 'executed', 'proof_verified'] },
            label: str,
            state: { type: 'string', enum: ['done', 'pending', 'failed', 'unknown', 'skipped'] },
            detail: str,
          },
          required: ['id', 'label', 'state'],
          additionalProperties: false,
        },
      },
      effect: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['native_transfer', 'contract_call', 'none'] },
          state: { type: 'string', enum: ['confirmed', 'not_observed', 'unchecked', 'unreadable', 'not_applicable'] },
          detail: str,
          amount: str,
          symbol: str,
          recipient: { type: 'object', additionalProperties: true },
          sender: { type: 'object', additionalProperties: true },
          expected_event: { type: 'object', properties: { found: { type: ['boolean', 'null'] } }, required: ['found'], additionalProperties: false },
        },
        required: ['kind', 'state', 'detail'],
        additionalProperties: false,
      },
      proof: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['verified', 'partial', 'failed', 'no_evidence', 'pending', 'unavailable', 'not_applicable'] },
          detail: str,
          checked_here: bool,
          node_checked: bool,
          layers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: str, title: str,
                verdict: { type: 'string', enum: ['verified', 'failed', 'not_checked', 'not_in_document'] },
                reason: str, statement: str,
                evidence: { type: 'object', additionalProperties: true },
              },
              required: ['id', 'title', 'verdict'],
              additionalProperties: false,
            },
          },
          layers_total: { type: 'integer' },
          layers_verified: { type: 'integer' },
          layers_not_carried: { type: 'integer' },
          not_established: {
            type: 'array',
            items: { type: 'object', properties: { id: str, title: str, reason: str }, required: ['id', 'title', 'reason'], additionalProperties: false },
          },
          proof_id: strOrNull,
          evidence: {
            type: 'object',
            properties: { found: bool, code: str, reason: str, bundle_error: str },
            required: ['found'],
            additionalProperties: false,
          },
        },
        required: ['verdict', 'detail', 'checked_here', 'node_checked', 'layers', 'layers_total', 'layers_verified', 'layers_not_carried', 'not_established', 'proof_id', 'evidence'],
        additionalProperties: false,
      },
      verdict: { type: 'string', enum: ['verified', 'partial', 'failed', 'pending', 'unproven'] },
      headline: str,
      gaps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              enum: [
                'INTENT_NOT_TERMINAL', 'PROOF_PENDING', 'PROOF_NOT_FETCHED', 'PROOF_NO_EVIDENCE', 'PROOF_LAYER_NOT_ESTABLISHED', 'PROOF_LAYER_FAILED',
                'NODE_NOT_CONSULTED', 'EFFECT_UNCHECKED', 'EFFECT_UNREADABLE', 'EFFECT_NOT_OBSERVED',
              ],
            },
            text: str,
          },
          required: ['code', 'text'],
          additionalProperties: false,
        },
      },
      recipient_snapshot: { type: ['object', 'null'], additionalProperties: true },
    },
    required: [
      'receipt_version', 'intent_id', 'kind', 'created_at', 'updated_at', 'gateway', 'request', 'signed_with', 'status', 'ids', 'links', 'stages',
      'effect', 'proof', 'verdict', 'headline', 'gaps', 'recipient_snapshot',
    ],
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
