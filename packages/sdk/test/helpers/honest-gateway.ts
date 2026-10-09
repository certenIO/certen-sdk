import { reconstructSigning } from '@certen.io/proof-verify';
import { keccak256, toHex } from '../../src/execution-proof.js';
import { legsFromIntent } from '../../src/signing-check.js';

/**
 * What an honest gateway returns now that signing data carries the unsigned transaction: the transaction a CERTEN bridge builds for the
 * request it received, the signature metadata, and the hashes computed from both. Used by the flow tests, whose subject is the flow
 * (what is sent, where it goes, what is signed) and not the check; the check has its own tests against real transactions.
 */
export const KEY_PAGE = 'acc://seller-bot.acme/book/1';

const hexOf = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('hex');

export async function honestIntent(
  body: any,
  opts: { intentId?: string; publicKey?: string; keyPage?: string; submitUrl?: string; status?: number } = {},
) {
  const intentId = opts.intentId ?? 'intent-1';
  const publicKey = opts.publicKey ?? body.signer_public_key ?? '11'.repeat(32);
  const intent = body.intent ?? {};
  const adi = String(intent.adiUrl);
  const legs = await legsFromIntent(intent);
  const blobs = [
    { kind: 'CERTEN_INTENT', version: '2.0', intent_id: intentId, leg_count: legs.length },
    {
      protocol: 'CERTEN',
      version: '2.0',
      operationGroupId: intentId,
      legs: legs.map((l, i) => {
        const callData = (l.callData ?? '0x').toLowerCase();
        return {
          legId: `leg-${i + 1}`, role: 'payment', chain: String(l.chainId), chainId: l.chainId,
          executionPayload: {
            target: l.target, value: String(l.value), callData, dataHash: `0x${toHex(keccak256(Buffer.from(callData.slice(2), 'hex'))).replace(/^0x/, '')}`, chainId: l.chainId,
            ...(l.expectedEvents ? { expectedEvents: l.expectedEvents } : {}),
          },
        };
      }),
    },
    { organizationAdi: adi },
    { nonce: 'n', created_at: 1 },
  ];
  const header: Record<string, unknown> = { principal: `${adi}/data`, memo: 'CERTEN_INTENT' };
  if (body.expires_at) header.expire = { atTime: new Date(body.expires_at).toISOString() };
  if (body.additional_authorities?.length) header.authorities = body.additional_authorities;
  const transaction = { header, body: { type: 'writeData', entry: { type: 'doubleHash', data: blobs.map(hexOf) } } };
  const metadata = { type: 'ed25519', public_key: publicKey, signer: opts.keyPage ?? body.signer_key_page ?? KEY_PAGE, signer_version: 1, timestamp_us: 1790000000000000 };
  const r = reconstructSigning(transaction, metadata);
  const withInitiator = { ...transaction, header: { ...header, initiator: r.signatureMetadataHash } };
  return {
    status: opts.status ?? 201,
    body: {
      intent_id: intentId,
      signing_mode: 'external',
      signing_data: { transaction_hash: r.transactionHash, hash_to_sign: r.hashToSign, transaction: withInitiator, signature_metadata: metadata },
      submit_url: opts.submitUrl ?? `/v1/transaction/${intentId}/signature`,
    },
  };
}

/** A governance operation as the gateway names it, to the Accumulate transaction a bridge builds for it. */
export function honestGovernance(
  op: any,
  adiUrl: string,
  opts: { id?: string; publicKey?: string; keyPage?: string; status?: string } = {},
) {
  let principal = `${adiUrl}/book/1`;
  let body: Record<string, unknown>;
  switch (op.type) {
    case 'add_key': body = { type: 'updateKeyPage', operation: [{ type: 'add', entry: { keyHash: op.public_key_hash } }] }; break;
    case 'remove_key': body = { type: 'updateKeyPage', operation: [{ type: 'remove', entry: { keyHash: op.public_key_hash } }] }; break;
    case 'set_threshold': body = { type: 'updateKeyPage', operation: [{ type: 'setThreshold', threshold: Number(op.threshold) }] }; break;
    case 'add_authority': principal = op.account_url ?? adiUrl; body = { type: 'updateAccountAuth', operations: [{ type: 'addAuthority', authority: op.authority_url }] }; break;
    case 'remove_authority': principal = op.account_url ?? adiUrl; body = { type: 'updateAccountAuth', operations: [{ type: 'removeAuthority', authority: op.authority_url }] }; break;
    default: throw new Error(`honestGovernance: no recipe for ${op.type}`);
  }
  const metadata = { type: 'ed25519', public_key: opts.publicKey ?? '11'.repeat(32), signer: opts.keyPage ?? `${adiUrl}/book/1`, signer_version: 1, timestamp_us: 1790000000000000 };
  const transaction = { header: { principal }, body };
  const r = reconstructSigning(transaction, metadata);
  return {
    status: 201,
    body: {
      governance_op_id: opts.id ?? 'gov-1',
      status: opts.status ?? 'pending_signature',
      signing_data: { transaction_hash: r.transactionHash, hash_to_sign: r.hashToSign, transaction: { ...transaction, header: { ...transaction.header, initiator: r.signatureMetadataHash } }, signature_metadata: metadata },
    },
  };
}

/** An existing transaction to co-sign, and the signing data for a co-signature on it. The returned hash is the transaction's real id. */
export function honestCosign(tx: { transaction: any; txid: string }, meta: { publicKey: string; signer: string; vote?: string }, id = 'sr-1') {
  const metadata = { type: 'ed25519', public_key: meta.publicKey, signer: meta.signer, signer_version: 1, timestamp_us: 1790000000000001, ...(meta.vote ? { vote: meta.vote } : {}) };
  const r = reconstructSigning(tx.transaction, metadata, true);
  return {
    status: 201,
    body: {
      sign_request_id: id,
      signing_data: { transaction_hash: r.transactionHash, data_for_signature: r.hashToSign, transaction: tx.transaction, signature_metadata: metadata },
      submit_url: `/v1/sign/${id}/signature`,
    },
  };
}
