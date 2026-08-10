import type { CertenClient } from '@certen.io/sdk';

/**
 * Tool definitions, split into two tiers.
 *
 * READ tools are always available. WRITE tools are only registered when `CERTEN_MCP_ALLOW_WRITES=1`
 * — the gate is at the server level, not in a prompt. A tool that is never registered cannot be
 * called by a confused model, a prompt injection, or a bug; a tool that is registered with
 * "please don't call this" in its description can be called by all three.
 *
 * Two invariants hold across this file, and `test/tiers.test.ts` enforces both:
 *
 *   1. **No tool ever accepts a private key or produces a signature.** The signing flow is: open an
 *      intent, receive `hash_to_sign`, sign it wherever the key actually lives, submit the
 *      signature. The server sees the hash and the signature — never the key. The SDK's central
 *      guarantee is that your key never reaches it, and a server that autonomously held one would
 *      undo that.
 *   2. **Every write tool requires `confirm: true`.** Without it the tool returns a description of
 *      what it *would* do and changes nothing.
 *
 * There is deliberately NO funding tool, in either tier. Balance and obligations are readable so an
 * agent can say what work will cost and why a call was refused — but opening a payment or
 * registering a payer address is spending on the operator's behalf, and an agent that could do it
 * would be an agent that can move money. Those stay on the portal and the CLI, where a human is
 * present. Reading is explanation; the remedy belongs to the person.
 */

export type Tier = 'read' | 'write';

export interface ToolDef {
  name: string;
  /** Visibility gate: whether this tool is registered at all without CERTEN_MCP_ALLOW_WRITES=1. */
  tier: Tier;
  /**
   * Confirmation gate: whether this tool CHANGES something, and so must be called twice.
   *
   * Deliberately independent of `tier`. The admin read tools sit in the write tier because they
   * enumerate credentials and belong behind the same door as rotating them — but there is nothing
   * to confirm about a list, and demanding confirm:true for a read would train a model to pass it
   * reflexively, which is exactly the habit the gate exists to prevent.
   */
  mutates: boolean;
  description: string;
  /** The gateway operation this reaches, as `METHOD /path` — checked against the vendored spec. */
  endpoint: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  run: (client: CertenClient, args: Record<string, unknown>) => Promise<unknown>;
}

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });

/** Every write tool carries this, and refuses to act without it. */
const CONFIRM = {
  type: 'boolean',
  description:
    'Must be true to actually perform this action. Call once without it to see exactly what would '
    + 'happen, then call again with confirm:true. This is a deliberate stop before an irreversible step.',
};

function s(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`missing required string: ${key}`);
  return v;
}

function optS(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function optN(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' ? v : undefined;
}

// ── read tier ───────────────────────────────────────────────────────────────────────────────────

const READ_TOOLS: ToolDef[] = [
  {
    name: 'certen_identity_get',
    tier: 'read',
    mutates: false,
    endpoint: 'GET /v1/identity/{id}',
    description:
      'Fetch one identity by id. Check `can_sign` before assuming the identity can authorize '
      + 'anything: provisioning is asynchronous, so an identity can exist while still unable to sign.',
    inputSchema: {
      type: 'object',
      properties: { identityId: str('Identity UUID') },
      required: ['identityId'],
      additionalProperties: false,
    },
    run: (c, a) => c.identity.get(s(a, 'identityId')),
  },
  {
    name: 'certen_portfolio_get',
    tier: 'read',
    mutates: false,
    endpoint: 'GET /v1/portfolio',
    description: 'Balances across every identity and chain in the organization. Optionally filtered to one identity.',
    inputSchema: {
      type: 'object',
      properties: { identityId: str('Optional identity UUID to filter to') },
      additionalProperties: false,
    },
    run: (c, a) => c.portfolio.get(optS(a, 'identityId')),
  },
  {
    name: 'certen_billing_balance',
    tier: 'read',
    mutates: false,
    endpoint: 'GET /v1/billing/balance',
    description:
      'What the organization can spend. `spendable_usd` is available balance plus any credit line. '
      + 'Read certen_billing_obligations too before concluding work is affordable: pending intents '
      + 'may have claimed this balance already.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (c) => c.billing.balance(),
  },
  {
    name: 'certen_billing_obligations',
    tier: 'read',
    mutates: false,
    endpoint: 'GET /v1/billing/obligations',
    description:
      'Work already committed and what it will cost. `remaining_usd` is the amount that may actually '
      + 'be committed to something new — spendable minus what pending intents will consume. Gate on '
      + 'that, not on the balance: a multi-signature intent can wait weeks for quorum, so an account '
      + 'can hold a balance that is entirely spoken for and still be refused on its next call.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (c) => c.billing.obligations(),
  },
  {
    name: 'certen_transaction_get',
    tier: 'read',
    mutates: false,
    endpoint: 'GET /v1/transaction/{id}',
    description:
      'Status of one transaction intent. Terminal states are completed/delivered/proven (success) '
      + 'and failed/error. Anything else means it is still in flight.',
    inputSchema: {
      type: 'object',
      properties: { intentId: str('Intent id returned when the transaction was opened') },
      required: ['intentId'],
      additionalProperties: false,
    },
    run: (c, a) => c.transaction.get(s(a, 'intentId')),
  },
  {
    name: 'certen_transaction_list',
    tier: 'read',
    mutates: false,
    endpoint: 'GET /v1/transactions',
    description: 'List transaction intents, most recent first.',
    inputSchema: {
      type: 'object',
      properties: { limit: num('Max results'), offset: num('Offset') },
      additionalProperties: false,
    },
    run: (c, a) => c.transaction.list({ limit: optN(a, 'limit'), offset: optN(a, 'offset') }),
  },
  {
    name: 'certen_pending_list',
    tier: 'read',
    mutates: false,
    endpoint: 'GET /v1/pending',
    description: 'The pending actions inbox — things waiting on a signature or an approval.',
    inputSchema: {
      type: 'object',
      properties: {
        identityId: str('Filter by identity'),
        status: str('Filter by status'),
        category: str('Filter by category'),
        limit: num('Max results'),
        offset: num('Offset'),
      },
      additionalProperties: false,
    },
    run: (c, a) =>
      c.pending.list({
        identity: optS(a, 'identityId'),
        status: optS(a, 'status'),
        category: optS(a, 'category'),
        limit: optN(a, 'limit'),
        offset: optN(a, 'offset'),
      } as never),
  },
  {
    name: 'certen_governance_get',
    tier: 'read',
    mutates: false,
    endpoint: 'GET /v1/governance/{id}',
    description:
      'Status and details of a governance operation — its type, original request, signing data, '
      + 'resulting Accumulate transaction hash and timestamps.',
    inputSchema: {
      type: 'object',
      properties: { governanceId: str('Governance operation id') },
      required: ['governanceId'],
      additionalProperties: false,
    },
    run: (c, a) => c.governance.get(s(a, 'governanceId')),
  },
  {
    name: 'certen_proof_get',
    tier: 'read',
    mutates: false,
    endpoint: 'GET /v1/proof/{id}',
    description:
      'The proof for a completed intent — the evidence to hand a counterparty so they verify rather '
      + 'than trust. Falls back to the Accumulate merkle receipt when an intent has no cross-chain '
      + 'proof_id, which is normal for governance and authorization transactions.',
    inputSchema: {
      type: 'object',
      properties: { intentId: str('Intent id') },
      required: ['intentId'],
      additionalProperties: false,
    },
    run: (c, a) => c.execute.proof(s(a, 'intentId')),
  },
  {
    name: 'certen_execute_wait',
    tier: 'read',
    mutates: false,
    endpoint: 'GET /v1/transaction/{id}',
    description:
      'Poll an intent until it reaches a terminal state. THIS TAKES 60-110 SECONDS in the normal '
      + 'case — that is real validator work, not a tunable delay. Do not treat a slow response as a '
      + 'hang, and do not retry it: a second call just starts a second poll against the same intent. '
      + 'Default budget is 360s. Prefer certen_transaction_get if you only want the current state.',
    inputSchema: {
      type: 'object',
      properties: {
        intentId: str('Intent id'),
        timeoutMs: num('Give up after this many ms (default 360000)'),
      },
      required: ['intentId'],
      additionalProperties: false,
    },
    run: (c, a) => c.execute.wait(s(a, 'intentId'), { timeoutMs: optN(a, 'timeoutMs') ?? 360_000 }),
  },
];

// ── write tier ──────────────────────────────────────────────────────────────────────────────────

const WRITE_TOOLS: ToolDef[] = [
  {
    name: 'certen_identity_create',
    tier: 'write',
    mutates: true,
    endpoint: 'POST /v1/identity',
    description:
      'Provision a new identity. Consumes organization identity quota and is asynchronous: this '
      + 'returns 202 and provisioning continues. Poll certen_identity_get until the status is '
      + 'terminal and can_sign is true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Identity name — must be unique in the org'),
        publicKeyHash: str('sha256 of the RAW 32-byte public key, hex'),
        publicKey: str('Public key, 64-char hex'),
        chains: { type: 'array', items: { type: 'string' }, description: 'Chains to link' },
        credits: num('Initial credits'),
        confirm: CONFIRM,
      },
      required: ['name', 'publicKeyHash', 'confirm'],
      additionalProperties: false,
    },
    run: (c, a) =>
      c.identity.create({
        name: s(a, 'name'),
        publicKeyHash: s(a, 'publicKeyHash'),
        publicKey: optS(a, 'publicKey'),
        chains: Array.isArray(a.chains) ? (a.chains as string[]) : undefined,
        credits: optN(a, 'credits'),
      }),
  },
  {
    name: 'certen_identity_update',
    tier: 'write',
    mutates: true,
    endpoint: 'PATCH /v1/identity/{id}',
    description: 'Link or unlink chains on an identity, or set its webhook URL.',
    inputSchema: {
      type: 'object',
      properties: {
        identityId: str('Identity UUID'),
        linkChains: { type: 'array', items: { type: 'string' }, description: 'Chains to link' },
        unlinkChains: { type: 'array', items: { type: 'string' }, description: 'Chains to unlink' },
        webhookUrl: str('Webhook URL'),
        confirm: CONFIRM,
      },
      required: ['identityId', 'confirm'],
      additionalProperties: false,
    },
    run: (c, a) =>
      c.identity.update(s(a, 'identityId'), {
        linkChains: Array.isArray(a.linkChains) ? (a.linkChains as string[]) : undefined,
        unlinkChains: Array.isArray(a.unlinkChains) ? (a.unlinkChains as string[]) : undefined,
        webhookUrl: optS(a, 'webhookUrl'),
      } as never),
  },
  {
    name: 'certen_identity_retire',
    tier: 'write',
    mutates: true,
    endpoint: 'DELETE /v1/identity/{id}',
    description: 'Retire an identity, freeing its quota slot. Not reversible.',
    inputSchema: {
      type: 'object',
      properties: { identityId: str('Identity UUID'), confirm: CONFIRM },
      required: ['identityId', 'confirm'],
      additionalProperties: false,
    },
    run: (c, a) => c.identity.retire(s(a, 'identityId')),
  },
  {
    name: 'certen_transaction_open',
    tier: 'write',
    mutates: true,
    endpoint: 'POST /v1/transaction',
    description:
      'Open a transaction intent and return its `signing_data.hash_to_sign`. '
      + 'THIS SERVER DOES NOT SIGN AND HOLDS NO KEY. Nothing executes until a signature is submitted '
      + 'with certen_transaction_submit_signature. Sign the RAW BYTES of the returned hex hash '
      + 'wherever the key actually lives — do not hash it again and do not sign the ASCII of the hex.',
    inputSchema: {
      type: 'object',
      properties: {
        identityId: str('Identity UUID that will sign'),
        intent: {
          type: 'object',
          description:
            'Either a native transfer ({fromChain,toChain,amount,fromAddress,toAddress,tokenSymbol}) '
            + 'or a multi-leg/contract-call intent ({adiUrl,legs:[...]}). Amounts are base units as STRINGS.',
        },
        // An OBJECT keyed by role — not a list, and not the address being called. Declared as a string
        // array, this invited exactly the payload the endpoint rejects with
        // `/contract_addresses must be object`: the same bug that made every SDK contractCall fail with
        // a 400 naming a field the caller never set by hand.
        contractAddresses: {
          type: 'object',
          description:
            'Override the CERTEN deployment addresses (anchor, anchorV2, abstractAccount, entryPoint, '
            + 'factory). OMIT unless targeting a non-standard deployment — the gateway applies the '
            + 'correct defaults. This is NOT the contract you are calling.',
        },
        signerKeyPage: str('Which key page signs, e.g. acc://org.acme/book/2'),
        signerPublicKey: str('Which seat on the page signs, 64-char hex'),
        proofClass: {
          type: 'string',
          enum: ['on_demand', 'on_cadence'],
          description:
            'When the proof cycle runs. `on_demand` (default) starts immediately and takes roughly '
            + '60-110 seconds. `on_cadence` batches it with other proofs: cheaper, slower. Affects when '
            + 'the proof is produced, never what it proves.',
        },
        idempotencyKey: str('Idempotency key. One is generated if omitted — do not omit it on a retry.'),
        confirm: CONFIRM,
      },
      required: ['identityId', 'intent', 'confirm'],
      additionalProperties: false,
    },
    run: (c, a) =>
      c.transaction.create({
        identityId: s(a, 'identityId'),
        intent: a.intent as never,
        // Pass through only when it is the object the endpoint expects; an array here is the caller
        // misreading the field, and forwarding it just produces a confusing 400.
        contractAddresses: (a.contractAddresses && typeof a.contractAddresses === 'object'
          && !Array.isArray(a.contractAddresses)) ? (a.contractAddresses as never) : undefined,
        signerKeyPage: optS(a, 'signerKeyPage'),
        signerPublicKey: optS(a, 'signerPublicKey'),
        proofClass: optS(a, 'proofClass') as never,
        idempotencyKey: optS(a, 'idempotencyKey'),
      } as never),
  },
  {
    name: 'certen_transaction_submit_signature',
    tier: 'write',
    mutates: true,
    endpoint: 'POST /v1/transaction/{id}/signature',
    description:
      'Submit a signature you produced elsewhere, authorizing the intent to execute. '
      + 'THIS IS THE POINT OF NO RETURN — after this the transaction is relayed and executes on '
      + 'chain. The signature must come from the key nominated when the intent was opened.',
    inputSchema: {
      type: 'object',
      properties: {
        intentId: str('Intent id'),
        signature: str('Signature over hash_to_sign, 128-char hex'),
        publicKey: str('Public key that produced the signature, 64-char hex'),
        confirm: CONFIRM,
      },
      required: ['intentId', 'signature', 'publicKey', 'confirm'],
      additionalProperties: false,
    },
    run: (c, a) =>
      c.transaction.submitSignature(s(a, 'intentId'), {
        signature: s(a, 'signature'),
        publicKey: s(a, 'publicKey'),
      } as never),
  },
  {
    name: 'certen_sign_create',
    tier: 'write',
    mutates: true,
    endpoint: 'POST /v1/sign',
    description:
      'Open a sign request — a vote on a multi-signature transaction. Returns signing data to be '
      + 'signed elsewhere. `vote` is a lowercase string: approve, reject or abstain (not "accept", '
      + 'not a number). The vote is folded into the signature preimage, so it is fixed here and '
      + 'cannot be changed when the signature is submitted.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: str('Accumulate transaction hash being voted on'),
        identity: str('Identity ADI, e.g. acc://org.acme'),
        signerUrl: str('Signer URL'),
        publicKey: str('Public key that will sign, 64-char hex'),
        vote: { type: 'string', enum: ['approve', 'reject', 'abstain'], description: 'Vote to cast' },
        confirm: CONFIRM,
      },
      required: ['targetId', 'identity', 'signerUrl', 'publicKey', 'confirm'],
      additionalProperties: false,
    },
    run: (c, a) =>
      c.sign.create({
        type: 'pending_tx',
        targetId: s(a, 'targetId'),
        identity: s(a, 'identity'),
        signerUrl: s(a, 'signerUrl'),
        publicKey: s(a, 'publicKey'),
        vote: optS(a, 'vote') ?? 'approve',
      } as never),
  },
  {
    name: 'certen_sign_submit_signature',
    tier: 'write',
    mutates: true,
    endpoint: 'POST /v1/sign/{id}/signature',
    description:
      'Submit the signature for a sign request, casting the vote. A spent sign request 404s rather '
      + 'than replaying — on failure, open a fresh sign request instead of resubmitting.',
    inputSchema: {
      type: 'object',
      properties: {
        signRequestId: str('Sign request id'),
        signature: str('Signature, 128-char hex'),
        publicKey: str('Public key that produced it, 64-char hex'),
        confirm: CONFIRM,
      },
      required: ['signRequestId', 'signature', 'publicKey', 'confirm'],
      additionalProperties: false,
    },
    run: (c, a) =>
      c.sign.submitSignature(s(a, 'signRequestId'), {
        signature: s(a, 'signature'),
        publicKey: s(a, 'publicKey'),
      } as never),
  },
  {
    name: 'certen_governance_submit_signature',
    tier: 'write',
    mutates: true,
    endpoint: 'POST /v1/governance/{id}/signature',
    description:
      'Submit a signature for a governance operation — changing delegates, thresholds or key pages. '
      + 'Governance changes alter who can authorize future transactions, so a mistake here is not '
      + 'limited to one transaction.',
    inputSchema: {
      type: 'object',
      properties: {
        governanceId: str('Governance operation id'),
        signature: str('Signature, 128-char hex'),
        publicKey: str('Public key that produced it, 64-char hex'),
        confirm: CONFIRM,
      },
      required: ['governanceId', 'signature', 'publicKey', 'confirm'],
      additionalProperties: false,
    },
    run: (c, a) =>
      c.governance.submitSignature(s(a, 'governanceId'), {
        signature: s(a, 'signature'),
        publicKey: s(a, 'publicKey'),
      } as never),
  },
  {
    name: 'certen_admin_list_api_keys',
    tier: 'write',
    mutates: false,
    endpoint: 'GET /v1/admin/api-keys',
    description:
      'List the organization API keys. Read-only, but in the write tier because it enumerates '
      + 'credentials and belongs behind the same gate as rotating them.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (c) => c.admin.listApiKeys(),
  },
  {
    name: 'certen_admin_audit_log',
    tier: 'write',
    mutates: false,
    endpoint: 'GET /v1/admin/audit-log',
    description:
      'Organization audit log entries — who did what, and when. Filterable by action and date range.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('Filter by action'),
        from: str('From date, ISO'),
        to: str('To date, ISO'),
        limit: num('Max results'),
        offset: num('Offset'),
      },
      additionalProperties: false,
    },
    run: (c, a) =>
      c.admin.getAuditLog({
        action: optS(a, 'action'),
        from: optS(a, 'from'),
        to: optS(a, 'to'),
        limit: optN(a, 'limit'),
        offset: optN(a, 'offset'),
      } as never),
  },
  {
    name: 'certen_admin_usage',
    tier: 'write',
    mutates: false,
    endpoint: 'GET /v1/admin/usage',
    description:
      'Organization usage summary over a date range — call volume and quota consumption.',
    inputSchema: {
      type: 'object',
      properties: { from: str('From date, ISO'), to: str('To date, ISO') },
      additionalProperties: false,
    },
    run: (c, a) => c.admin.getUsage({ from: optS(a, 'from'), to: optS(a, 'to') }),
  },
  {
    name: 'certen_admin_rotate_api_key',
    tier: 'write',
    mutates: true,
    endpoint: 'POST /v1/admin/api-keys/{id}/rotate',
    description:
      'Rotate an API key: mints a replacement and revokes the old one. Anything still using the old '
      + 'key breaks immediately. The new key is shown once.',
    inputSchema: {
      type: 'object',
      properties: { apiKeyId: str('API key UUID'), confirm: CONFIRM },
      required: ['apiKeyId', 'confirm'],
      additionalProperties: false,
    },
    run: (c, a) => c.admin.rotateApiKey(s(a, 'apiKeyId')),
  },
  {
    name: 'certen_admin_revoke_api_key',
    tier: 'write',
    mutates: true,
    endpoint: 'DELETE /v1/admin/api-keys/{id}',
    description: 'Revoke an API key. Immediate and not reversible.',
    inputSchema: {
      type: 'object',
      properties: { apiKeyId: str('API key UUID'), confirm: CONFIRM },
      required: ['apiKeyId', 'confirm'],
      additionalProperties: false,
    },
    run: (c, a) => c.admin.revokeApiKey(s(a, 'apiKeyId')),
  },
];

export const ALL_TOOLS: ToolDef[] = [...READ_TOOLS, ...WRITE_TOOLS];

/** Writes are opt-in through the environment, never through a prompt. */
export function writesAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CERTEN_MCP_ALLOW_WRITES === '1';
}

export function activeTools(env: NodeJS.ProcessEnv = process.env): ToolDef[] {
  return writesAllowed(env) ? ALL_TOOLS : READ_TOOLS;
}

export { READ_TOOLS, WRITE_TOOLS };
