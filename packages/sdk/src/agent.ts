import { createHash, createPrivateKey, createPublicKey, sign as nodeSign, generateKeyPairSync } from 'node:crypto';
import type { CertenClient } from './client.js';
import type { SignFn, OpenedIntent } from './resources/execute.js';
import type {
  ChainAccount,
  ContractCall,
  CreateGovernanceResponse,
  Identity,
  ProofClass,
  ProofShare,
  TransactionResponse,
} from './types.js';
import { CertenError } from './errors.js';

/**
 * CertenAgent — one identity, any chain, every verb an autonomous agent needs.
 *
 * The gateway's resources mirror its endpoints: identities, transactions, governance, signing,
 * proofs. An agent that wants to *be* something on CERTEN has to compose them in the right order
 * with the right key at every step, and every integration that did so by hand made the same
 * mistakes — signing the ASCII of a hash, forgetting the ADI on a transfer, wiring an escrow ABI
 * into the core. This is that composition, written once, escrow-free.
 *
 * What an agent is here: an Accumulate ADI (its identity), a key book (who may sign for it), and
 * one abstract account per chain (its `msg.sender` there, derived from the ADI). The verbs:
 *
 *   provision()        create the ADI and its first chain account(s), wait until active
 *   linkChain()        reach another chain with the same ADI — no new identity, no new key
 *   transfer()         move native value from the agent's account, proof-gated
 *   token()            move an ERC-20 from the agent's account, proof-gated (a `transfer` call)
 *   call()             any contract call from the agent's account, proof-gated
 *   cosign()           add this agent's signature to a pending action on a shared page
 *   pending()          the inbox of things waiting on this agent
 *   proof() / share()  the proof of what happened, and a link a stranger verifies with no account
 *   governance.*       add a seat, set a threshold, name a policy signer as a required authority
 *
 * YOUR KEY NEVER REACHES THE GATEWAY. The agent holds a `signer` — a public key and a function that
 * signs 32 raw bytes — and hands the gateway signatures, never the key. `ed25519Signer()` makes one
 * from a seed for the common case; anything that can sign Ed25519 (an HSM, a policy signer, a
 * hardware key) fits the same shape.
 */

/** Signs raw bytes for one Ed25519 key. `sign` receives the hex of the bytes to sign and returns 128 hex. */
export interface AgentSigner {
  /** 64 hex — the raw 32-byte Ed25519 public key. */
  publicKey: string;
  /** 64 hex — sha256 of the raw public key bytes, which is how a key page names a key. */
  publicKeyHash: string;
  sign: SignFn;
}

/**
 * An Ed25519 signer from a 32-byte seed (64 hex). The seed is the private half; keep it where the
 * agent alone can read it. Omit the seed to generate a fresh key — and persist `seedHex` yourself,
 * because a key that only ever lived in memory cannot sign for the identity it created.
 */
export function ed25519Signer(seedHex?: string): AgentSigner & { seedHex: string } {
  let seed: Buffer;
  if (seedHex) {
    seed = Buffer.from(seedHex.replace(/^0x/, ''), 'hex');
    if (seed.length !== 32) throw new CertenError('ed25519Signer: seed must be 32 bytes (64 hex)', 0, 'BAD_SEED');
  } else {
    const { privateKey } = generateKeyPairSync('ed25519');
    const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    seed = der.subarray(der.length - 32);
  }
  // PKCS#8 wrapper for a raw Ed25519 seed: fixed 16-byte prefix + the 32-byte seed.
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKeyBytes = spki.subarray(spki.length - 32);
  const publicKey = publicKeyBytes.toString('hex');
  const publicKeyHash = createHash('sha256').update(publicKeyBytes).digest('hex');
  return {
    publicKey,
    publicKeyHash,
    seedHex: seed.toString('hex'),
    // Sign the RAW BYTES of the hex — never the ASCII of the hex.
    sign: (hashHex: string) => nodeSign(null, Buffer.from(hashHex.replace(/^0x/, ''), 'hex'), privateKey).toString('hex'),
  };
}

export interface CertenAgentState {
  identityId: string;
  adiUrl: string;
  keyPageUrl: string | null;
  /** chain id → abstract account address on that chain. */
  accounts: Record<string, string>;
}

export interface ProvisionParams {
  /** ADI name, e.g. `seller-bot-7`. Becomes `acc://<name>.acme`. */
  name: string;
  /** Chains to open an account on now. More can be linked later. */
  chains: string[];
  /** Accumulate credits for the key page. The gateway default (500) covers thousands of write-backs. */
  credits?: number;
  timeoutMs?: number;
  /** Poll cadence while waiting for accounts. Leave unset outside tests. */
  pollIntervalMs?: number;
  onPoll?: (identity: Identity) => void;
}

/** Common knobs on every proof-gated action. */
interface ActionOpts {
  proofClass?: ProofClass;
  idempotencyKey?: string;
  /** Sign with a different page of the book, e.g. a priority page — the seat still has to be on it. */
  signerKeyPage?: string;
  /** Submit even if the account is known to hold no gas. */
  skipFundingCheck?: boolean;
}

export class CertenAgent {
  readonly state: CertenAgentState;

  /**
   * @param client  A configured client. The API key on it is the organization's; the agent's own
   *                authority is the signer, which is what the key book knows.
   * @param signer  The agent's Ed25519 key, as a signer — see `ed25519Signer`.
   * @param state   An already-provisioned identity, to resume. Omit to `provision()` a new one.
   */
  constructor(
    private readonly client: CertenClient,
    readonly signer: AgentSigner,
    state?: CertenAgentState,
  ) {
    this.state = state ?? { identityId: '', adiUrl: '', keyPageUrl: null, accounts: {} };
  }

  /** The agent's abstract account on a chain, or a clear error if it has none there yet. */
  account(chain: string): string {
    const addr = this.state.accounts[chain];
    if (!addr) {
      throw new CertenError(
        `agent ${this.state.adiUrl || '(unprovisioned)'} has no account on ${chain} — call linkChain('${chain}') first`,
        0, 'NO_ACCOUNT_ON_CHAIN',
      );
    }
    return addr;
  }

  private requireIdentity(): void {
    if (!this.state.identityId) {
      throw new CertenError('agent is not provisioned — call provision() or pass state to the constructor', 0, 'NOT_PROVISIONED');
    }
  }

  // ---- identity -------------------------------------------------------------------------------

  /**
   * Create the agent's identity: an ADI bound to this signer's key, with an abstract account on each
   * chain in `chains`. Waits until the identity is active and every requested account has an address.
   */
  async provision(p: ProvisionParams): Promise<CertenAgentState> {
    if (this.state.identityId) {
      throw new CertenError(`agent is already provisioned as ${this.state.adiUrl}`, 0, 'ALREADY_PROVISIONED');
    }
    const identity = await this.client.identity.createAndWait({
      name: p.name,
      publicKey: this.signer.publicKey,
      publicKeyHash: this.signer.publicKeyHash,
      chains: p.chains,
      credits: p.credits,
    }, { timeoutMs: p.timeoutMs, intervalMs: p.pollIntervalMs, onPoll: p.onPoll });
    this.state.identityId = identity.id;
    this.state.adiUrl = identity.adi_url;
    this.state.keyPageUrl = identity.key_page_url;
    this.absorbAccounts((identity as Identity & { chain_accounts?: ChainAccount[] }).chain_accounts);
    await this.waitForAccounts(p.chains, p.timeoutMs, p.pollIntervalMs);
    return this.state;
  }

  /**
   * Reach another chain with the same identity. One PATCH and an account deploy; the ADI, the key
   * book and every policy on it are unchanged. Resolves to the new account's address.
   */
  async linkChain(chain: string, { timeoutMs, pollIntervalMs }: { timeoutMs?: number; pollIntervalMs?: number } = {}): Promise<string> {
    this.requireIdentity();
    if (this.state.accounts[chain]) return this.state.accounts[chain];
    const updated = await this.client.identity.update(this.state.identityId, { linkChains: [chain] });
    this.absorbAccounts((updated as Identity & { chain_accounts?: ChainAccount[] }).chain_accounts);
    await this.waitForAccounts([chain], timeoutMs, pollIntervalMs);
    return this.state.accounts[chain];
  }

  /** Re-read the identity from the gateway and refresh the account map. */
  async refresh(): Promise<CertenAgentState> {
    this.requireIdentity();
    const identity = await this.client.identity.get(this.state.identityId);
    this.state.adiUrl = identity.adi_url ?? this.state.adiUrl;
    this.state.keyPageUrl = identity.key_page_url ?? this.state.keyPageUrl;
    this.absorbAccounts((identity as Identity & { chain_accounts?: ChainAccount[] }).chain_accounts);
    return this.state;
  }

  private absorbAccounts(accounts?: ChainAccount[]): void {
    for (const a of accounts ?? []) {
      const chain = String((a as { chain_id?: string; chain?: string }).chain_id ?? (a as { chain?: string }).chain ?? '');
      const address = (a as { address?: string }).address;
      if (chain && address) this.state.accounts[chain] = address;
    }
  }

  private async waitForAccounts(chains: string[], timeoutMs = 300_000, intervalMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (chains.some((c) => !this.state.accounts[c])) {
      if (Date.now() > deadline) {
        const missing = chains.filter((c) => !this.state.accounts[c]);
        throw new CertenError(
          `identity ${this.state.adiUrl} is saved but has no account yet on ${missing.join(', ')} — provisioning is slower than usual, not lost; call refresh() later`,
          0, 'ACCOUNT_PENDING',
        );
      }
      await new Promise((r) => setTimeout(r, intervalMs));
      await this.refresh();
    }
  }

  // ---- proof-gated actions --------------------------------------------------------------------

  /** Move native value from the agent's account on `chain`. `amount` is WHOLE units, e.g. "0.001". */
  async transfer(p: { chain: string; to: string; amount: string } & ActionOpts): Promise<OpenedIntent> {
    this.requireIdentity();
    return this.client.execute.transfer({
      identityId: this.state.identityId,
      adiUrl: this.state.adiUrl,
      fromChain: p.chain,
      toChain: p.chain,
      fromAddress: this.account(p.chain),
      toAddress: p.to,
      amount: p.amount,
      sign: this.signer.sign,
      publicKey: this.signer.publicKey,
      signerKeyPage: p.signerKeyPage,
      proofClass: p.proofClass,
      idempotencyKey: p.idempotencyKey,
      skipFundingCheck: p.skipFundingCheck,
    });
  }

  /**
   * Any contract call from the agent's account, proof-gated: the validators execute exactly this
   * (target, value, calldata) or nothing. `value` is wei. Name the events the call must emit so
   * the proof is of the effect, not merely of non-revert.
   */
  async call(p: { chain: string; call: ContractCall; chainId?: number } & ActionOpts): Promise<OpenedIntent> {
    this.requireIdentity();
    return this.client.execute.contractCall({
      identityId: this.state.identityId,
      adiUrl: this.state.adiUrl,
      fromAddress: this.account(p.chain),
      chain: p.chain,
      chainId: p.chainId,
      contractCall: p.call,
      sign: this.signer.sign,
      publicKey: this.signer.publicKey,
      signerKeyPage: p.signerKeyPage,
      proofClass: p.proofClass,
      idempotencyKey: p.idempotencyKey,
      skipFundingCheck: p.skipFundingCheck,
    });
  }

  /**
   * Move an ERC-20 from the agent's account: a proof-gated `transfer(to, amount)` on the token
   * contract. `amount` is in the token's base units as a string (USDC has 6 decimals: "1000000" is
   * one USDC). The policy signer decodes this calldata and gates on the token amount.
   */
  async token(p: { chain: string; token: string; to: string; amount: string; chainId?: number } & ActionOpts): Promise<OpenedIntent> {
    if (!/^\d+$/.test(p.amount)) {
      throw new CertenError(`token: amount must be an integer in the token's base units, got ${JSON.stringify(p.amount)}`, 0, 'BAD_AMOUNT');
    }
    return this.call({
      ...p,
      call: {
        target: p.token,
        functionSignature: 'transfer(address,uint256)',
        args: [p.to, p.amount],
        value: '0',
        // Transfer(address indexed from, address indexed to, uint256 value)
        expectedEvents: [{ contract: p.token, topic0: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' }],
      },
    });
  }

  /** Add this agent's vote to a pending action on a page it holds a seat on. */
  async cosign(p: { accumTxHash: string; signerUrl?: string; vote?: 'approve' | 'reject' | 'abstain' }): Promise<Record<string, unknown>> {
    this.requireIdentity();
    const signerUrl = p.signerUrl ?? this.state.keyPageUrl;
    if (!signerUrl) throw new CertenError('cosign: no key page known for this agent — pass signerUrl', 0, 'NO_KEY_PAGE');
    return this.client.execute.cosign({
      accumTxHash: p.accumTxHash,
      identity: this.state.adiUrl,
      signerUrl,
      publicKey: this.signer.publicKey,
      sign: this.signer.sign,
      vote: p.vote,
    });
  }

  /** Things waiting on this agent's signature. */
  pending(params?: Parameters<CertenClient['pending']['list']>[0]) {
    return this.client.pending.list(params);
  }

  /** Wait for an intent to reach a terminal state. */
  wait(intentId: string, opts?: Parameters<CertenClient['execute']['wait']>[1]): Promise<TransactionResponse> {
    return this.client.execute.wait(intentId, opts);
  }

  /** The proof of an intent — a CERTEN proof artifact, or the anchored Accumulate receipt if none exists yet. */
  proof(intentId: string, opts?: Parameters<CertenClient['execute']['proof']>[1]) {
    return this.client.execute.proof(intentId, opts);
  }

  /**
   * A link a counterparty verifies against CERTEN with no account of its own. Resolves the intent's
   * proof first; throws NO_PROOF_YET if only the Accumulate receipt exists (proofs anchor 60–120 s
   * after the leg completes — wait and retry).
   */
  async share(intentId: string, params: { label?: string; expiresInHours?: number; maxViews?: number } = {}): Promise<ProofShare> {
    const p = await this.proof(intentId);
    if (p.kind !== 'certen-proof') {
      throw new CertenError(`intent ${intentId} has no proof artifact yet — it anchors after the leg completes; retry shortly`, 0, 'NO_PROOF_YET');
    }
    return this.client.proof.share(p.proofId, { expiresInHours: params.expiresInHours ?? 72, label: params.label, maxViews: params.maxViews });
  }

  // ---- governance -----------------------------------------------------------------------------

  /**
   * Who may sign for this agent, and under what rules. Every operation here is itself signed by the
   * agent's key and lands on its key page; nothing about how the agent builds transactions changes.
   */
  readonly governance = {
    /** Seat another key on the agent's page — a co-signer, a human, a second agent. */
    addSeat: (publicKeyHash: string, opts: { signerKeyPage?: string } = {}) =>
      this.governanceOp({ type: 'add_key', public_key_hash: publicKeyHash }, opts),

    /** Remove a seat. */
    removeSeat: (publicKeyHash: string, opts: { signerKeyPage?: string } = {}) =>
      this.governanceOp({ type: 'remove_key', public_key_hash: publicKeyHash }, opts),

    /** How many seats must sign: M of N. */
    setThreshold: (threshold: number, opts: { signerKeyPage?: string } = {}) =>
      this.governanceOp({ type: 'set_threshold', threshold }, opts),

    /**
     * Name a key book as a REQUIRED AUTHORITY on the agent's identity. From then on every transaction
     * the agent submits sits pending until that book signs too — which is how the headless policy
     * signer regulates an agent: the owner's rules gate every spend, and the agent cannot opt out.
     *
     * Accumulate authorizes each account by ITS OWN authority set, and a key book's default authority
     * is itself. So an authority on the identity governs its data and token accounts but not
     * `addSeat` / `setThreshold` on the agent's page. Pass `{ account: 'book' }` (or a full account
     * URL under the identity) to name the book on the key book too: then who may act for the agent
     * is also the owner's decision, and the agent cannot undo it with its own key.
     */
    requireSigner: (bookUrl: string, opts: { signerKeyPage?: string; account?: 'identity' | 'book' | string } = {}) =>
      this.governanceOp({ type: 'add_authority', authority_url: bookUrl, ...this.authorityTarget(opts.account) }, opts),

    /** Remove a required authority (from the identity, or from the account named by `account`). */
    releaseSigner: (bookUrl: string, opts: { signerKeyPage?: string; account?: 'identity' | 'book' | string } = {}) =>
      this.governanceOp({ type: 'remove_authority', authority_url: bookUrl, ...this.authorityTarget(opts.account) }, opts),
  };

  /** The `account_url` for an authority operation: nothing for the identity, the key book for 'book', a URL as given. */
  private authorityTarget(account?: string): { account_url?: string } {
    if (!account || account === 'identity') return {};
    if (account === 'book') {
      this.requireIdentity();
      const book = this.state.keyPageUrl ? this.state.keyPageUrl.replace(/\/\d+$/, '') : `${this.state.adiUrl}/book`;
      return { account_url: book };
    }
    return { account_url: account };
  }

  private async governanceOp(operation: Record<string, unknown>, opts: { signerKeyPage?: string }): Promise<CreateGovernanceResponse> {
    this.requireIdentity();
    const created = await this.client.governance.create({
      identity: this.state.adiUrl,
      operations: [operation],
      signerKeyPage: opts.signerKeyPage,
      signerPublicKey: this.signer.publicKey,
    });
    const hash = created.signing_data?.hash_to_sign;
    if (!hash) return created; // provider-signed, or nothing to sign
    const signature = await this.signer.sign(hash);
    await this.client.governance.submitSignature(created.governance_op_id, { signature, publicKey: this.signer.publicKey });
    return created;
  }
}
