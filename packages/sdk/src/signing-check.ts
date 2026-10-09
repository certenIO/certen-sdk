/**
 * Check what a gateway asks you to sign, before you sign it.
 *
 * Every external-mode signature this SDK makes (`execute.contractCall`, `execute.transfer`, `execute.cosign`, `CertenAgent`'s governance
 * operations, and the CLI's `--sign-with`) goes through here first. The gateway returns the unsigned transaction and the signature
 * metadata beside `hash_to_sign`; `@certen.io/proof-verify` rebuilds the transaction, recomputes every hash, and compares what it
 * would authorise with what the caller asked for. A disagreement throws `SIGNING_DATA_MISMATCH` naming the field; data the gateway did not
 * send throws `SIGNING_DATA_ABSENT`; and nothing is signed either way. There is no option that signs without the check.
 *
 * The verifier is an OPTIONAL peer dependency, loaded on first use so the API client keeps its one runtime dependency. Signing without it
 * installed is refused (`SIGNING_VERIFIER_UNAVAILABLE`), not waved through.
 */
import { CertenError } from './errors.js';
import { chainInfo } from './chains.js';
import type { Expectation, ExpectedLeg, ExpectedOperation, SigningSummary } from '@certen.io/proof-verify';

export type { Expectation, ExpectedLeg, ExpectedOperation, SigningSummary };

export const SIGNING_DATA_MISMATCH = 'SIGNING_DATA_MISMATCH';
export const SIGNING_DATA_ABSENT = 'SIGNING_DATA_ABSENT';
export const SIGNING_VERIFIER_UNAVAILABLE = 'SIGNING_VERIFIER_UNAVAILABLE';
export const SIGNING_EXPECTATION_UNAVAILABLE = 'SIGNING_EXPECTATION_UNAVAILABLE';

/** A signature was refused because what would be signed could not be shown to be what was asked for. `details` has `field`, `expected`, `actual`. */
export class CertenSigningDataError extends CertenError {
  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message, 0, code, details ? { details } : undefined);
    this.name = 'CertenSigningDataError';
  }
}

type Verifier = typeof import('@certen.io/proof-verify');
const VERIFIER_MODULE: string = '@certen.io/proof-verify';
let loaded: Promise<Verifier> | undefined;

async function verifier(): Promise<Verifier> {
  // The specifier is not a literal on purpose: a browser bundle must not try to resolve the verifier (it uses node:crypto), and so does not.
  // In a browser this fails at run time as SIGNING_VERIFIER_UNAVAILABLE: signing there is refused, not unchecked.
  loaded ??= import(/* @vite-ignore */ VERIFIER_MODULE).catch((e: unknown) => {
    loaded = undefined;
    const missing = e && typeof e === 'object' && ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes((e as { code?: string }).code ?? '');
    throw new CertenSigningDataError(
      missing
        ? 'certen: refusing to sign. Checking what a gateway asks you to sign needs @certen.io/proof-verify (npm install @certen.io/proof-verify), and there is no option to sign without the check.'
        : `certen: refusing to sign. The signing-data verifier could not be loaded: ${e instanceof Error ? e.message : String(e)}`,
      SIGNING_VERIFIER_UNAVAILABLE,
    );
  });
  return loaded;
}

function asCertenError(v: Verifier, e: unknown): never {
  if (e instanceof v.SigningDataMismatch) {
    throw new CertenSigningDataError(`certen: ${e.message}`, SIGNING_DATA_MISMATCH, { field: e.field, expected: e.expected, actual: e.actual });
  }
  if (e instanceof v.SigningDataAbsent) {
    throw new CertenSigningDataError(`certen: ${e.message}`, SIGNING_DATA_ABSENT, { missing: e.missing });
  }
  if (e instanceof v.AbiUnsupported) {
    throw new CertenSigningDataError(`certen: refusing to sign. ${e.message}`, SIGNING_EXPECTATION_UNAVAILABLE);
  }
  throw e;
}

/** Run a check; a refusal is a CertenSigningDataError. */
async function run(f: (v: Verifier) => SigningSummary): Promise<SigningSummary> {
  const v = await verifier();
  try {
    return f(v);
  } catch (e) {
    return asCertenError(v, e);
  }
}

const unavailable = (why: string): never => {
  throw new CertenSigningDataError(`certen: refusing to sign. ${why}`, SIGNING_EXPECTATION_UNAVAILABLE);
};

// ── expectations from a request ─────────────────────────────────────────────────────────────────────

/** Whole units ("0.001") to base units, exactly. */
export function toBaseUnits(amount: string, decimals: number): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!m) return unavailable(`the amount ${JSON.stringify(amount)} is not a decimal number, so what it moves cannot be checked`);
  const frac = m[2] ?? '';
  if (frac.length > decimals) return unavailable(`the amount ${amount} has more than ${decimals} decimal places`);
  return (BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')).toString();
}

interface CallLike { target: string; functionSignature?: string; args?: unknown[]; value?: string; expectedEvents?: Array<{ contract: string; topic0: string }> }

async function legFromCall(call: CallLike, chain: string | undefined, chainId: number | undefined): Promise<ExpectedLeg> {
  const id = chainId ?? chainInfo(chain)?.chainId;
  if (id === undefined) unavailable(`chain ${JSON.stringify(chain)} is not in the chain catalogue and no chainId was given, so the leg's chain cannot be checked`);
  const v = await verifier();
  let callData: string;
  try {
    callData = call.functionSignature ? v.encodeCall(call.functionSignature, call.args ?? []) : '0x';
  } catch (e) {
    return asCertenError(v, e);
  }
  return {
    chainId: id,
    target: call.target,
    value: call.value ?? '0',
    callData,
    ...(call.expectedEvents ? { expectedEvents: call.expectedEvents.map((e) => ({ contract: e.contract, topic0: e.topic0 })) } : {}),
  };
}

/** The legs a `{ legs: [...] }` intent must produce. A leg whose meaning the SDK cannot state is refused, not skipped. */
export async function legsFromIntent(intent: Record<string, unknown>): Promise<ExpectedLeg[]> {
  const raw = intent.legs;
  if (Array.isArray(raw)) {
    const out: ExpectedLeg[] = [];
    for (const [i, l] of raw.entries()) {
      const leg = (l ?? {}) as Record<string, unknown>;
      const call = leg.contractCall as CallLike | undefined;
      if (call) {
        out.push(await legFromCall(call, leg.chain as string | undefined, leg.chainId as number | undefined));
      } else if (leg.tokenAddress || leg.tokenSymbol) {
        unavailable(`leg ${i + 1} moves a token; the token contract and its decimals are chosen downstream, so what it moves cannot be checked here`);
      } else {
        const info = chainInfo((leg.chainId ?? leg.chain) as string | number | undefined);
        if (!info) unavailable(`leg ${i + 1} names a chain outside the catalogue, so what it moves cannot be checked`);
        out.push({ chainId: info!.chainId, target: String(leg.toAddress ?? ''), value: toBaseUnits(String(leg.amount ?? ''), info!.nativeDecimals), callData: '0x' });
      }
    }
    return out;
  }
  if (intent.toChain && intent.toAddress && intent.amount !== undefined) {
    if (intent.tokenSymbol && String(intent.tokenSymbol).toUpperCase() !== chainInfo(intent.toChain as string)?.nativeSymbol.toUpperCase()) {
      unavailable('a token transfer\'s contract and decimals are chosen downstream, so what it moves cannot be checked here');
    }
    const info = chainInfo((intent.toChainId ?? intent.toChain) as string | number);
    if (!info) return unavailable(`chain ${JSON.stringify(intent.toChain)} is not in the chain catalogue, so what the transfer moves cannot be checked`);
    return [{ chainId: info.chainId, target: String(intent.toAddress), value: toBaseUnits(String(intent.amount), info.nativeDecimals), callData: '0x' }];
  }
  return unavailable('the intent has neither legs nor a transfer shape the SDK can state the meaning of');
}

// ── the checks ──────────────────────────────────────────────────────────────────────────────────────

export interface IntentSigningContext {
  intentId?: string;
  adiUrl: string;
  /** The intent as sent. */
  intent: Record<string, unknown>;
  signerPublicKey?: string;
  signerKeyPage?: string;
  additionalAuthorities?: string[];
  expiresAt?: Date | string;
}

/** Before signing a new intent (`POST /v1/transaction`). */
export async function checkIntentSigning(signingData: unknown, c: IntentSigningContext): Promise<SigningSummary> {
  if (!c.adiUrl) unavailable('the identity\'s ADI is not known, so where the intent must be written cannot be checked');
  const legs = await legsFromIntent(c.intent);
  return run((v) => v.verifySigningData(signingData, {
    ...(c.intentId ? { intentId: c.intentId } : {}),
    adiUrl: c.adiUrl,
    legs,
    ...(c.signerPublicKey ? { signerPublicKey: c.signerPublicKey } : {}),
    ...(c.signerKeyPage ? { signerKeyPage: c.signerKeyPage } : {}),
    additionalAuthorities: c.additionalAuthorities ?? [],
    ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}),
  }));
}

export interface CosignContext {
  /** The existing transaction the signature is for. */
  transactionHash: string;
  signerPublicKey: string;
  signerKeyPage: string;
  vote: 'approve' | 'reject' | 'abstain';
}

/** Before co-signing a transaction that already exists (`POST /v1/sign`): its own hash, the vote, and the signer. */
export async function checkCosigning(signingData: unknown, c: CosignContext): Promise<SigningSummary> {
  return run((v) => v.verifySigningData(signingData, {
    transactionHash: c.transactionHash.replace(/^acc:\/\//, '').match(/[0-9a-f]{64}/i)?.[0] ?? c.transactionHash,
    signerPublicKey: c.signerPublicKey,
    signerKeyPage: c.signerKeyPage,
    vote: c.vote,
  }, { existing: true }));
}

export interface GovernanceSigningContext {
  adiUrl: string;
  operations: ExpectedOperation[];
  signerPublicKey?: string;
  signerKeyPage?: string;
}

/** Before signing a governance change (`POST /v1/governance`). */
export async function checkGovernanceSigning(signingData: unknown, c: GovernanceSigningContext): Promise<SigningSummary> {
  return run((v) => v.verifySigningData(signingData, {
    adiUrl: c.adiUrl,
    governance: c.operations,
    ...(c.signerPublicKey ? { signerPublicKey: c.signerPublicKey } : {}),
    ...(c.signerKeyPage ? { signerKeyPage: c.signerKeyPage } : {}),
  }));
}

/**
 * Rebuild and describe signing data without a request to compare it with: every hash is recomputed and must match, and the summary says what
 * the signature would authorise. It cannot say whether that is what you meant, so it is for inspecting and for a person to read, and signing
 * after it is the person's decision. `existing` is for a co-signature on a transaction that already exists.
 */
export async function inspectSigningData(signingData: unknown, opts: { existing?: boolean; signerPublicKey?: string } = {}): Promise<SigningSummary> {
  return run((v) => v.verifySigningData(signingData, opts.signerPublicKey ? { signerPublicKey: opts.signerPublicKey } : {}, { existing: opts.existing === true }));
}
