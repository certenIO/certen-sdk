/**
 * Response contract tests — does what the SDK DECLARES match what the API RETURNS?
 *
 * `contract.test.ts` guards the request direction. Nothing guarded this one, and the result was
 * that every response interface in the SDK was camelCase while the API is snake_case, and the
 * resources do `return data` with no transformation. TypeScript reported `intentId: string`; the
 * value was `undefined`. `execute.ts` was unaffected only because it had been written against real
 * responses and reads snake_case directly.
 *
 * The check is deliberately mechanical: build a value of each declared response type with every
 * property populated, then assert those keys exist in the gateway's own OpenAPI response schema.
 * Renaming a field in types.ts without the API agreeing fails here, in the direction that matters —
 * a declared field the API never sends is a field that is `undefined` at runtime.
 *
 * Refresh the fixture with: node scripts/build-contract-fixture.mjs
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CreateTransactionResponse, TransactionResponse, ListTransactionsResponse, SubmitSignatureResponse,
  IdentityResponse, DeleteIdentityResponse,
  CreateGovernanceResponse, GovernanceResponse, SubmitGovernanceSignatureResponse,
  SignResponse, SubmitSignSignatureResponse,
  PortfolioResponse, PendingActionsResponse,
  OrgResponse, ApiKeyResponse,
} from '../src/index.js';

interface Contract {
  paths: Record<string, Record<string, {
    responses: Record<string, string[]>;
    responseShapes: Record<string, Record<string, string[]>>;
  }>>;
}
const CONTRACT: Contract = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/openapi-contract.json'), 'utf8'),
);

function specProps(path: string, method: string, code: string): string[] {
  const props = CONTRACT.paths[path]?.[method]?.responses?.[code];
  if (!props) throw new Error(`fixture has no ${method.toUpperCase()} ${path} -> ${code} response`);
  return props;
}

function specNested(path: string, method: string, code: string, key: string): string[] {
  const shape = CONTRACT.paths[path]?.[method]?.responseShapes?.[code]?.[key];
  if (!shape) throw new Error(`fixture has no nested shape for ${key} on ${method.toUpperCase()} ${path} -> ${code}`);
  return shape;
}

/**
 * Every key of the declared type must be something the API actually sends.
 *
 * The reverse is not required: the SDK may legitimately omit response fields it does not model.
 * It is the extra declared field — the one that reads `undefined` forever — that is the bug.
 */
function declaredKeysExistInSpec(
  declared: Record<string, unknown>,
  allowed: string[],
  label: string,
  undocumented: string[] = [],
): void {
  const unknownKeys = Object.keys(declared)
    .filter((k) => !allowed.includes(k) && !undocumented.includes(k));
  expect(unknownKeys, `${label}: declared but not in the API response`).toEqual([]);
}

/**
 * Fields the gateway genuinely returns but its OpenAPI spec does not declare.
 *
 * Observed on a live `GET /v1/pending` against gateway.kompendium.co on 2026-07-31. The SDK models
 * them because they are real and useful — `user_has_signed` and `is_ready` are what an inbox filters
 * on. They are listed here rather than silently tolerated so the exception stays visible and gets
 * removed when the gateway's response schema is completed.
 */
const UNDOCUMENTED_PENDING_FIELDS = ['awaiting_authorities', 'is_ready', 'chain_status'];

describe('response types match the API', () => {
  it('POST /v1/transaction', () => {
    const sample: Required<Pick<CreateTransactionResponse,
      'intent_id' | 'status' | 'signing_mode' | 'signing_data' | 'submit_url' | 'tx_hash' | 'proof_id' | 'idempotent'>> = {
      intent_id: 'i', status: 's', signing_mode: 'external',
      signing_data: { request_id: 'r', transaction_hash: 't', hash_to_sign: 'h' },
      submit_url: 'u', tx_hash: 'x', proof_id: 'p', idempotent: false,
    };
    declaredKeysExistInSpec(sample, specProps('/v1/transaction', 'post', '201'), 'CreateTransactionResponse');
    declaredKeysExistInSpec(
      sample.signing_data as unknown as Record<string, unknown>,
      specNested('/v1/transaction', 'post', '201', 'signing_data'),
      'IntentSigningData',
    );
  });

  it('GET /v1/transaction/{id}', () => {
    const sample: Record<keyof TransactionResponse, unknown> = {
      intent_id: 'i', identity_id: 'd', status: 's', intent_type: 't', accum_tx_hash: 'a',
      proof_id: 'p', proof_bundle_url: 'b', error_message: null,
      created_at: 'c', updated_at: 'u', completed_at: 'f', proof: {},
    };
    declaredKeysExistInSpec(sample, specProps('/v1/transaction/{id}', 'get', '200'), 'TransactionResponse');
  });

  it('GET /v1/transactions', () => {
    const sample: Record<keyof ListTransactionsResponse, unknown> = { transactions: [], limit: 1, offset: 0 };
    declaredKeysExistInSpec(sample, specProps('/v1/transactions', 'get', '200'), 'ListTransactionsResponse');
  });

  it('POST /v1/transaction/{id}/signature', () => {
    const sample: Record<keyof SubmitSignatureResponse, unknown> = { intent_id: 'i', status: 's', tx_hash: 'x' };
    declaredKeysExistInSpec(sample, specProps('/v1/transaction/{id}/signature', 'post', '200'), 'SubmitSignatureResponse');
  });

  it('GET /v1/identity/{id}', () => {
    // The identity's own fields are top-level now — `IdentityResponse extends Identity` — so every
    // one of them has to be declared in the spec, not just the wrapper key that used to stand in
    // for all of them. That is the point of this check: before the flatten, `identity: {}` satisfied
    // it while saying nothing about what was inside.
    const sample: Record<keyof IdentityResponse, unknown> = {
      id: 'i', adi_url: 'acc://x.acme', book_url: null, key_page_url: null, status: 'active',
      can_sign: true, error_message: null, credit_balance: 0, chain_accounts: [], created_at: 'now',
      signing_mode: 'external', signing_provider: {}, mnemonic_retrieval: undefined,
      warning: undefined, governance: undefined, balances: undefined, pending: undefined,
    };
    // mnemonic_retrieval/warning appear on create, not on get — check each against its own response.
    const getProps = [...specProps('/v1/identity/{id}', 'get', '200'), ...specProps('/v1/identity', 'post', '202')];
    declaredKeysExistInSpec(sample, getProps, 'IdentityResponse');
  });

  it('the identity object itself', () => {
    // Checked against the RESPONSE's own properties, not a nested `identity` object — there is no
    // longer one to look inside. That is the improvement: these keys are now declared on the
    // response itself, so the spec describes them individually instead of hiding them behind a
    // wrapper it said nothing about.
    const identity = {
      id: 'i', adi_url: 'a', book_url: null, key_page_url: null, status: 's',
      can_sign: true, error_message: null, credit_balance: 0, chain_accounts: [], created_at: 'c',
    };
    declaredKeysExistInSpec(identity, specProps('/v1/identity/{id}', 'get', '200'), 'Identity');
  });

  it('DELETE /v1/identity/{id}', () => {
    const sample: Record<keyof DeleteIdentityResponse, unknown> = { deleted: true, id: 'i', adi_url: 'a', note: 'n' };
    declaredKeysExistInSpec(sample, specProps('/v1/identity/{id}', 'delete', '200'), 'DeleteIdentityResponse');
  });

  it('POST /v1/governance', () => {
    const sample: Record<keyof CreateGovernanceResponse, unknown> = {
      governance_op_id: 'g', status: 's', tx_hash: 'x', signing_mode: 'external',
      signing_data: {}, submit_url: 'u',
    };
    declaredKeysExistInSpec(sample, specProps('/v1/governance', 'post', '201'), 'CreateGovernanceResponse');
  });

  it('GET /v1/governance/{id}', () => {
    const sample: Record<keyof GovernanceResponse, unknown> = {
      governance_op_id: 'g', identity_id: 'i', operation_type: 'o', status: 's',
      request_payload: {}, signing_data: {}, accum_tx_hash: 'a', created_at: 'c', completed_at: 'f',
    };
    declaredKeysExistInSpec(sample, specProps('/v1/governance/{id}', 'get', '200'), 'GovernanceResponse');
  });

  it('POST /v1/governance/{id}/signature', () => {
    const sample: Record<keyof SubmitGovernanceSignatureResponse, unknown> = {
      governance_op_id: 'g', status: 's', tx_hash: 'x',
    };
    declaredKeysExistInSpec(sample, specProps('/v1/governance/{id}/signature', 'post', '200'), 'SubmitGovernanceSignatureResponse');
  });

  it('POST /v1/sign — and its signing data is NOT the intent shape', () => {
    const sample: Record<keyof SignResponse, unknown> = {
      sign_request_id: 'r', status: 's', tx_hash: 'x', signature_count: 1,
      signing_mode: 'external', signing_data: {}, submit_url: 'u', expires_at: 'e',
    };
    declaredKeysExistInSpec(sample, specProps('/v1/sign', 'post', '201'), 'SignResponse');

    const signingData = {
      data_for_signature: 'd', transaction_hash: 't', signer_url: 'u', signer_version: 1, timestamp: 0,
    };
    const nested = specNested('/v1/sign', 'post', '201', 'signing_data');
    declaredKeysExistInSpec(signingData, nested, 'SignRequestSigningData');

    // The distinction that made a single shared `SigningData` type wrong: this endpoint carries the
    // bytes under `data_for_signature`, the intent endpoint under `hash_to_sign`.
    expect(nested).toContain('data_for_signature');
    expect(nested).not.toContain('hash_to_sign');
    expect(specNested('/v1/transaction', 'post', '201', 'signing_data')).toContain('hash_to_sign');
  });

  it('POST /v1/sign/{id}/signature', () => {
    const sample: Record<keyof SubmitSignSignatureResponse, unknown> = {
      status: 's', tx_hash: 'x', signature_count: 1,
    };
    declaredKeysExistInSpec(sample, specProps('/v1/sign/{id}/signature', 'post', '200'), 'SubmitSignSignatureResponse');
  });

  it('GET /v1/portfolio', () => {
    const sample: Record<keyof PortfolioResponse, unknown> = { identities: [], total_chains: 0 };
    declaredKeysExistInSpec(sample, specProps('/v1/portfolio', 'get', '200'), 'PortfolioResponse');

    const identity = {
      adi_url: 'a', status: 's', credit_balance: 0, chains: [], pending_actions: 0,
    };
    declaredKeysExistInSpec(identity, specNested('/v1/portfolio', 'get', '200', 'identities'), 'PortfolioIdentity');
  });

  it('GET /v1/pending', () => {
    const sample: Record<keyof PendingActionsResponse, unknown> = { actions: [], stats: {}, pagination: {} };
    declaredKeysExistInSpec(sample, specProps('/v1/pending', 'get', '200'), 'PendingActionsResponse');

    const action = {
      id: 'i', identity_id: null, identity_url: null, category: 'c', type: 't', status: 's',
      tx_hash: 'h', tx_id: null, principal: null, transaction_type: null,
      collected_signatures: 0, total_authorities: 0, required_signatures: 0, approved_authorities: 0,
      user_has_signed: false, awaiting_authorities: [], is_ready: false, chain_status: {},
      expires_at: null, discovered_at: 'd', created_at: 'c',
    };
    declaredKeysExistInSpec(
      action,
      specNested('/v1/pending', 'get', '200', 'actions'),
      'PendingAction',
      UNDOCUMENTED_PENDING_FIELDS,
    );
  });

  it('records which pending fields the gateway spec is still missing', () => {
    // Fails once the gateway documents them, which is the prompt to delete the exception above.
    const documented = specNested('/v1/pending', 'get', '200', 'actions');
    for (const f of UNDOCUMENTED_PENDING_FIELDS) {
      expect(documented, `${f} is now in the spec — drop it from UNDOCUMENTED_PENDING_FIELDS`).not.toContain(f);
    }
  });

  it('POST /v1/admin/org', () => {
    const sample: Record<keyof OrgResponse, unknown> = { id: 'i', name: 'n', plan: 'p', created_at: 'c' };
    declaredKeysExistInSpec(sample, specProps('/v1/admin/org', 'post', '201'), 'OrgResponse');
  });

  it('POST /v1/admin/api-keys', () => {
    const sample: Record<keyof ApiKeyResponse, unknown> = { api_key: {}, warning: 'w' };
    declaredKeysExistInSpec(sample, specProps('/v1/admin/api-keys', 'post', '201'), 'ApiKeyResponse');
    declaredKeysExistInSpec(
      { id: 'i', key: 'k', name: 'n', prefix: 'p', rate_limit_rpm: 0, permissions: [], created_at: 'c' },
      specNested('/v1/admin/api-keys', 'post', '201', 'api_key'),
      'ApiKeyResponse.api_key',
    );
  });

  it('no response type is declared in camelCase', () => {
    // The original defect in one assertion. Every response key the SDK declares above is snake_case
    // or a single lowercase word; a camelCase key here means someone reintroduced the mismatch.
    const allDeclared = [
      'intent_id', 'identity_id', 'signing_data', 'hash_to_sign', 'data_for_signature',
      'adi_url', 'credit_balance', 'chain_accounts', 'can_sign', 'total_chains',
      'governance_op_id', 'sign_request_id', 'api_key', 'rate_limit_rpm',
    ];
    for (const k of allDeclared) {
      expect(k, `${k} should not be camelCase`).not.toMatch(/[a-z][A-Z]/);
    }
  });
});
