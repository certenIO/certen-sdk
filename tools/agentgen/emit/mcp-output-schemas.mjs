import { toJsonSchema, successSchemaOf } from '../lib/jsonschema.mjs';

/**
 * The MCP tools' `outputSchema`, generated from the gateway's own response schemas in the vendored spec.
 *
 * Three kinds of tool:
 *   - PASSTHROUGH: the tool returns the gateway's response body unchanged, so its schema is that response's schema, converted to
 *     JSON Schema (jsonschema.mjs). Everything not listed below is one; the generator FAILS if such a tool has no documented object
 *     response, so a tool cannot silently end up without a schema.
 *   - EXTENDED: the response plus fields the tool adds. The added fields are declared here, next to the tool they belong to.
 *   - CUSTOM: the tool builds its own result (verification reports, the enabled-chain report, the whoami summary, the doctor report ...).
 *     Those schemas are written by hand in packages/mcp/src/output-schemas.ts, and packages/mcp/test/structured-output.test.ts runs every
 *     tool and validates what it really returns against them.
 *
 * Where the gateway documents a response only as `object`, the tool's schema is `{"type":"object"}`: it says exactly as much as the
 * gateway does, and no more.
 */

/** Tools whose result the tool itself builds. Their schemas live in packages/mcp/src/output-schemas.ts. */
export const CUSTOM_TOOLS = [
  'certen_admin_revoke_api_key',   // the gateway answers 204 with no body; the SDK returns {success, message}
  'certen_billing_verify_receipt', // a ReceiptVerification built client-side from four requests
  'certen_chains_enabled',         // the configured chain set narrowed by the gateway's list
  'certen_doctor',                 // a DoctorReport assembled from several calls
  'certen_identity_create',        // 202 with no documented body, or the identity once it can sign
  'certen_proof_get',              // execute.proof(): a proof or a receipt, tagged with `kind`
  'certen_proof_verify',           // a summary built from the receipt
  'certen_whoami',                 // a reduced view of the balance
];

/** What `intentOutcome()` returns (packages/sdk/src/intent-states.ts); pinned by a test that feeds it every status. */
export const INTENT_OUTCOME_SCHEMA = {
  type: 'object',
  description: 'The named state of the action itself: completed, completed_unproven, executed, failed, pending or unknown.',
  properties: {
    status: { type: 'string', description: "The gateway's status, verbatim." },
    class: { type: 'string', enum: ['in_flight', 'executed', 'terminal_success', 'terminal_gas_only', 'terminal_failure', 'unknown'] },
    terminal: { type: 'boolean' },
    outcome: { type: 'string', enum: ['completed', 'completed_unproven', 'executed', 'failed', 'pending', 'unknown'] },
    reason: { type: ['string', 'null'], description: 'For completed_unproven always execution_proof_unavailable; for a failure the gateway reason_code.' },
  },
  required: ['status', 'class', 'terminal', 'outcome', 'reason'],
  additionalProperties: false,
};

/** Tools that return a gateway response PLUS fields the tool adds. */
export const EXTENDED_TOOLS = {
  certen_execute_wait: { add: { outcome: INTENT_OUTCOME_SCHEMA }, required: ['outcome'] },
};

/** `name -> METHOD /path` for every tool in tools.ts, read from the source so the generator and the server cannot disagree. */
export function toolEndpoints(toolsSource) {
  const starts = [...toolsSource.matchAll(/name: '(certen_[a-z_]+)'/g)];
  const out = new Map();
  starts.forEach((m, i) => {
    const block = toolsSource.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : toolsSource.length);
    const e = /endpoint: '([A-Z]+ \/[^']*)'/.exec(block);
    if (e) out.set(m[1], e[1]);
  });
  return out;
}

export function emitMcpOutputSchemas({ spec, toolsSource }) {
  const components = spec.components?.schemas ?? {};
  const endpoints = toolEndpoints(toolsSource);
  const schemas = {};
  const problems = [];

  for (const [name, endpoint] of [...endpoints].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (CUSTOM_TOOLS.includes(name)) continue;
    const raw = successSchemaOf(spec, endpoint);
    if (!raw) { problems.push(`${name}: ${endpoint} documents no JSON success response`); continue; }
    const schema = toJsonSchema(raw, components);
    if (schema.type !== 'object') { problems.push(`${name}: the response of ${endpoint} is not an object schema (type ${JSON.stringify(schema.type)})`); continue; }
    const ext = EXTENDED_TOOLS[name];
    if (ext) {
      schema.properties = { ...(schema.properties ?? {}), ...ext.add };
      schema.required = [...new Set([...(schema.required ?? []), ...ext.required])];
    }
    schemas[name] = schema;
  }
  for (const name of CUSTOM_TOOLS) if (!endpoints.has(name)) problems.push(`${name} is listed as custom but is not a tool in tools.ts`);
  for (const name of Object.keys(EXTENDED_TOOLS)) if (!schemas[name]) problems.push(`${name} is extended but has no base schema`);
  if (problems.length) throw new Error(`mcp output schemas cannot be generated:\n  ${problems.join('\n  ')}`);

  return `// GENERATED by tools/agentgen/emit/mcp-output-schemas.mjs from spec/openapi.json and packages/mcp/src/tools.ts. Do not edit.
// \`npm run agentgen\` rewrites it and \`npm run agentgen:check\` fails CI when it is stale.
// Tools whose result the tool builds itself (${CUSTOM_TOOLS.length}) have hand-written schemas in output-schemas.ts.

export const GENERATED_OUTPUT_SCHEMAS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = ${JSON.stringify(schemas, null, 2)};
`;
}
