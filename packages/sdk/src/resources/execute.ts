import { AxiosInstance } from 'axios';
import { randomUUID } from 'crypto';
import { omitUndefined } from '../internal.js';
import type { ContractAddresses, ContractCall, ProofClass, TransactionIntent, TransactionResponse } from '../types.js';

/**
 * The proof-gated execution flow, as one call instead of four.
 *
 * The raw resources mirror the API: open an intent, sign what comes back, post the signature, poll, fetch
 * the proof. Every integration writes that same sequence, and every integration gets the same details
 * wrong — signing the ASCII of the hex instead of its bytes, dropping the idempotency key on a retry,
 * treating a `202` as completion, giving up during a proof cycle that legitimately takes two minutes.
 *
 * This existed twice already: once in the CARP escrow adapter and once in the example scripts, both
 * hand-rolled. Neither is escrow-shaped — it is just how you use the gateway — so it belongs here.
 *
 * YOUR KEY NEVER REACHES THIS CODE. You pass a `sign` function; the SDK hands it bytes and takes back a
 * signature. It cannot act without you.
 */

export interface SignFn {
  /** Sign the RAW BYTES of this hex string (do not hash it again, do not sign the ASCII). Return 128 hex. */
  (hashToSign: string): string | Promise<string>;
}

export interface ProofGatedCallParams {
  identityId: string;
  /** The signing identity's ADI, e.g. `acc://your-org.acme`. */
  adiUrl: string;
  /** The identity's abstract account — `msg.sender` on the destination chain. */
  fromAddress: string;
  chain: string;
  chainId?: number;
  contractCall: ContractCall;
  /**
   * Override the CERTEN deployment addresses (anchor, abstractAccount, …). Omit unless you are
   * pointing at a non-standard deployment — the gateway applies the correct defaults.
   */
  contractAddresses?: ContractAddresses;
  sign: SignFn;
  publicKey: string;
  /** Nominate a seat on the page. Defaults to `publicKey`. */
  signerPublicKey?: string;
  /** Nominate which page of the book signs, e.g. `acc://panel.acme/book/2`. */
  signerKeyPage?: string;
  /**
   * Schedule the proof cycle: `on_demand` (default, ~60–110s) or `on_cadence` (batched, cheaper,
   * slower). It changes when the proof is produced, never what it proves.
   */
  proofClass?: ProofClass;
  idempotencyKey?: string;
}

export interface TransferParams {
  identityId: string;
  /**
   * The signing identity's ADI, e.g. `acc://your-org.acme`.
   *
   * REQUIRED. Its absence is why this method never worked: the upstream native-transfer path reads
   * `intent.adiUrl` with no null check, so an intent without one threw upstream and came back as a
   * bodyless `502` — which reads as "the gateway is down", not "you omitted a field". See
   * certenIO/accumulate-api-bridge#1.
   *
   * Requiring it is not a breaking change in practice: every call that omitted it failed, so there
   * is no working code to break. It is the only one of the four fields that path needs which the
   * caller must supply — `id`, `initiatedBy` and `timestamp` are generated below.
   */
  adiUrl: string;
  fromChain: string;
  toChain: string;
  fromAddress: string;
  toAddress: string;
  /** Base units (wei) as a STRING — a JSON number silently loses precision past 2^53. */
  amount: string;
  tokenSymbol?: string;
  sign: SignFn;
  publicKey: string;
  signerPublicKey?: string;
  signerKeyPage?: string;
  /**
   * Schedule the proof cycle: `on_demand` (default, ~60–110s) or `on_cadence` (batched, cheaper,
   * slower). It changes when the proof is produced, never what it proves.
   */
  proofClass?: ProofClass;
  idempotencyKey?: string;
}

export interface OpenedIntent {
  intentId: string;
  accumTxHash?: string;
  signingMode?: string;
}

/** Terminal states. `wait()` stops on these rather than polling forever. */
const DONE = ['completed', 'delivered', 'proven'];
const FAILED = ['failed', 'error'];

/**
 * Proof fetches get a longer budget than the client's 30s default.
 *
 * Measured against the live gateway: fetching the Accumulate merkle receipt exceeded 30s and failed
 * as `NETWORK_ERROR`. Retrieving evidence for an already-completed transaction is exactly the call
 * that should wait rather than fail — nothing is pending on it, and the alternative is telling a
 * caller their proof does not exist when it does. Override per call with `proof(id, { timeoutMs })`.
 */
const PROOF_TIMEOUT_MS = 120_000;

export class ExecuteResource {
  constructor(
    private http: AxiosInstance,
    private newIdempotencyKey: () => string,
  ) {}

  /**
   * Authorize an arbitrary contract call, gated on proof.
   *
   * Opens the intent, signs what the gateway returns, and posts the signature back. Resolves once YOUR
   * signature is in — which on an M-of-N page is not the same as executed. Follow with `wait()`.
   */
  async contractCall(p: ProofGatedCallParams): Promise<OpenedIntent> {
    const intent: TransactionIntent = {
      adiUrl: p.adiUrl,
      legs: [{
        legId: 'leg-1',
        chain: p.chain,
        chainId: p.chainId,
        fromAddress: p.fromAddress,
        toAddress: p.contractCall.target,
        // The leg's value must match the call's, or a payable call goes out with the wrong wei attached
        // and the proof faithfully proves the wrong call.
        amount: p.contractCall.value ?? '0',
        contractCall: p.contractCall,
      }],
    };

    return this.open({
      identity_id: p.identityId,
      intent,
      // NOT the call target. `contract_addresses` names the CERTEN deployment (anchor, anchorV2,
      // abstractAccount, entryPoint, factory) and must be an OBJECT — this sent `[target]`, which
      // the endpoint rejects with `/contract_addresses must be object`, so every contractCall
      // failed with a 400 naming a field the caller never set. The gateway applies the right
      // defaults when it is omitted, so omitting it is correct; `contractAddresses` overrides it
      // only for a non-standard deployment.
      contract_addresses: p.contractAddresses,
      signer_public_key: p.signerPublicKey ?? p.publicKey,
      proof_class: p.proofClass,
      signer_key_page: p.signerKeyPage,
    }, p.sign, p.signerPublicKey ?? p.publicKey, p.idempotencyKey);
  }

  /** Authorize a native transfer, gated on proof. Same flow, simpler intent. */
  async transfer(p: TransferParams): Promise<OpenedIntent> {
    return this.open({
      identity_id: p.identityId,
      intent: {
        // The upstream native-transfer path requires adiUrl, id, initiatedBy AND timestamp, none of
        // which appear in the transfer shape the API documents. Omitting any one of them produces a
        // bodyless 502 rather than a validation error: `adiUrl` is dereferenced with no null check,
        // and `new Date(intent.timestamp).toISOString()` throws RangeError on undefined. Verified
        // field by field against the live gateway — see certenIO/accumulate-api-bridge#1.
        //
        // The multi-leg branch upstream already defaults id/initiatedBy/timestamp itself; this path
        // does not, so the SDK supplies them. Once the upstream defaults them too, these become
        // harmless no-ops rather than load-bearing.
        adiUrl: p.adiUrl,
        id: randomUUID(),
        initiatedBy: p.adiUrl,
        timestamp: Date.now(),
        fromChain: p.fromChain,
        toChain: p.toChain,
        fromAddress: p.fromAddress,
        toAddress: p.toAddress,
        amount: p.amount,
        tokenSymbol: p.tokenSymbol,
      },
      signer_public_key: p.signerPublicKey ?? p.publicKey,
      proof_class: p.proofClass,
      signer_key_page: p.signerKeyPage,
    }, p.sign, p.signerPublicKey ?? p.publicKey, p.idempotencyKey);
  }

  /**
   * Add a co-signature to a transaction another seat opened — the second half of an M-of-N panel.
   *
   * `vote` is a lowercase string: `approve`, `reject`, or `abstain`. Not `accept`, and not a number. The
   * vote is folded into the signature preimage, so it is fixed when the signing data is created — you
   * cannot ask for signing data and decide the vote afterwards.
   */
  async cosign(p: {
    accumTxHash: string;
    identity: string;
    signerUrl: string;
    publicKey: string;
    sign: SignFn;
    vote?: 'approve' | 'reject' | 'abstain';
  }): Promise<Record<string, unknown>> {
    const { data: prep } = await this.http.post('/v1/sign', omitUndefined({
      type: 'pending_tx',
      target_id: p.accumTxHash,
      identity: p.identity,
      signer_url: p.signerUrl,
      public_key: p.publicKey,
      vote: p.vote ?? 'approve',
    }));

    const toSign = prep?.signing_data?.data_for_signature ?? prep?.signing_data?.hash_to_sign;
    if (!toSign) throw new Error(`certen: no signing data returned for ${p.accumTxHash}`);

    const signature = await p.sign(toSign);
    // A spent sign_request_id 404s rather than replaying, so never retry by resubmitting — request fresh
    // signing data instead.
    const url = prep.submit_url ?? `/v1/sign/${prep.sign_request_id}/signature`;
    const { data } = await this.http.post(url, { signature, public_key: p.publicKey });
    return data;
  }

  /**
   * Poll an intent to a terminal state.
   *
   * A real proof cycle is 60–110 seconds of validator work, so the default budget is generous. This is not
   * a delay that can be tuned away, and a 30-second timeout around it will simply always fire.
   */
  async wait(
    intentId: string,
    { timeoutMs = 360_000, intervalMs = 8_000, onPoll }: {
      timeoutMs?: number;
      intervalMs?: number;
      onPoll?: (tx: TransactionResponse) => void;
    } = {},
  ): Promise<TransactionResponse> {
    const deadline = Date.now() + timeoutMs;
    let last: TransactionResponse | undefined;
    while (Date.now() < deadline) {
      const { data } = await this.http.get(`/v1/transaction/${intentId}`);
      last = data as TransactionResponse;
      onPoll?.(last);
      const status = String((last as unknown as { status?: string }).status ?? '');
      if (DONE.includes(status)) return last;
      if (FAILED.includes(status)) {
        const msg = (last as unknown as { error_message?: string }).error_message ?? '';
        throw new Error(`certen: intent ${intentId} ${status}${msg ? `: ${msg}` : ''}`);
      }
      await sleep(intervalMs);
    }
    // Deliberately neither success nor failure — the intent may still complete. Say which it is.
    const status = String((last as unknown as { status?: string } | undefined)?.status ?? 'unknown');
    throw new Error(`certen: intent ${intentId} still ${status} after ${timeoutMs}ms`);
  }

  /**
   * The evidence to hand a counterparty, so they verify rather than trust.
   *
   * Falls back to the Accumulate merkle receipt when there is no cross-chain `proof_id` — which is the
   * normal case for a governance or authorization transaction, and the case where a naive lookup returns
   * empty and looks like a bug.
   */
  async proof(
    intentId: string,
    { timeoutMs = PROOF_TIMEOUT_MS }: { timeoutMs?: number } = {},
  ): Promise<
    | { kind: 'certen-proof'; proofId: string; proof: unknown; intent: TransactionResponse }
    | { kind: 'accumulate-receipt'; txHash: string; receipt: unknown; intent: TransactionResponse }
  > {
    const { data: intent } = await this.http.get(`/v1/transaction/${intentId}`);
    const proofId = (intent as { proof_id?: string }).proof_id;
    if (proofId) {
      const { data: proof } = await this.http.get(`/v1/proof/${proofId}`, { timeout: timeoutMs });
      return { kind: 'certen-proof', proofId, proof, intent };
    }
    const hash = String((intent as { accum_tx_hash?: string }).accum_tx_hash ?? '').match(/([a-f0-9]{64})/)?.[1];
    if (!hash) {
      throw new Error(`certen: intent ${intentId} has neither a proof_id nor an Accumulate transaction hash`);
    }
    const { data: receipt } = await this.http.get(`/v1/proof/tx/${hash}/receipt`, { timeout: timeoutMs });
    return { kind: 'accumulate-receipt', txHash: hash, receipt, intent };
  }

  // ── shared open-and-sign ──────────────────────────────────────────────────────────────────────────

  private async open(
    body: Record<string, unknown>,
    sign: SignFn,
    publicKey: string,
    idempotencyKey?: string,
  ): Promise<OpenedIntent> {
    // An Idempotency-Key is not optional. A network error here is indistinguishable from success, and a
    // retry without one opens a SECOND intent — which on a value transfer means paying twice.
    const key = idempotencyKey ?? this.newIdempotencyKey();
    const { data: prep } = await this.http.post('/v1/transaction', omitUndefined(body), {
      headers: { 'Idempotency-Key': key },
    });

    const sd = (prep as { signing_data?: { hash_to_sign?: string; transaction_hash?: string } }).signing_data;
    if (!sd?.hash_to_sign) {
      // Provider mode (the gateway holds a key) returns no signing data. Continuing would let the caller
      // believe they authorized something they never signed.
      throw new Error(
        `certen: no signing_data on intent ${(prep as { intent_id?: string }).intent_id} `
        + `(signing_mode=${(prep as { signing_mode?: string }).signing_mode}). This flow requires external `
        + 'mode, where you hold the key.',
      );
    }

    const signature = await sign(sd.hash_to_sign);
    const submitUrl = (prep as { submit_url?: string }).submit_url
      ?? `/v1/transaction/${(prep as { intent_id?: string }).intent_id}/signature`;
    await this.http.post(submitUrl, { signature, public_key: publicKey });

    return {
      intentId: (prep as { intent_id: string }).intent_id,
      accumTxHash: sd.transaction_hash,
      signingMode: (prep as { signing_mode?: string }).signing_mode,
    };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
