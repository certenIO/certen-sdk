import { mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
// The measurement harness's fake gateway. It is plain JavaScript on purpose (scripts run it without a build) and is imported here as it is.
// @ts-ignore - no declaration file for a .mjs script
import { startFakeGateway, IDS } from '../../../../scripts/lib/fake-gateway.mjs';
import { certen, envelope, newHome, type RunResult } from './run-cli.js';

/**
 * A machine that has been through `certen setup`, against the fake gateway: an API key, one identity on base-sepolia whose key page lists the
 * local key, and one signing key. What `send`, `receipt` and `watch` start from.
 *
 * The home is a throwaway (`HOME` and `USERPROFILE`), the gateway is in-process on loopback, and nothing here reaches the network or the real
 * `~/.certen`. The fake VERIFIES what it can (the signing data is built the way the bridge builds it, so `checkIntentSigning` has something real
 * to rebuild), which is why a test that passes proves the CLI signed the right thing and not only that it signed.
 */
export interface FakeGateway {
  url: string;
  rpcUrl: string;
  take(): Array<{ method: string; path: string; status: number; unrouted: boolean }>;
  takeNodeCalls(): Array<{ method: string; params: unknown[] }>;
  lastIntent(): { body: Record<string, any> | null; transfer: { to: string; wei: bigint } | null };
  intentReads(): number;
  setNodeBalance(address: string, wei: string | bigint): void;
  adoptIdentity(keyHash: string): void;
  fundAbstractAccount(): void;
  execution: { blockNumber: number; txHash: string; chainId: number };
  close(): Promise<void>;
}

export interface SendEnv {
  home: string;
  gateway: FakeGateway;
  /** The local key's SHA-256 hash, which the identity's key page lists. */
  keyHash: string;
  run(args: string[], opts?: { input?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<RunResult>;
  close(): Promise<void>;
}

export const RECIPIENT = '0x1111111111111111111111111111111111111111';
export const ABSTRACT_ACCOUNT: string = IDS.abstractAccount;
export const INTENT_ID: string = IDS.intent;
export const IDENTITY_ID: string = IDS.identity;
export const ADI: string = IDS.adi;

export interface SendEnvOptions {
  /** Fake-gateway options: `statuses`, `fault`, `debitSender`. */
  gateway?: { statuses?: string[]; fault?: string; debitSender?: boolean; accumulateDown?: boolean };
  /** The abstract account holds gas. Default true. */
  funded?: boolean;
  /** Encrypt the key with this passphrase (the CLI is given it through CERTEN_KEY_PASSPHRASE). Default: unencrypted, so nothing prompts. */
  passphrase?: string;
  /** Record no identity in the config (a machine that has not been set up). */
  noIdentity?: boolean;
  /** Extra keys to make, by name (so a context key is ambiguous). */
  extraKeys?: string[];
  /** Make no signing key at all (a machine that has not made one), so the identity's key page lists a key nobody here holds. */
  noKey?: boolean;
}

/**
 * A key is made ONCE per passphrase, by the real `certen keys generate`, and copied into each throwaway home. Making one costs a process spawn
 * and (when encrypted) a scrypt derivation, which dominated the time of a file that makes a machine per case. A copy is a real key file in the
 * real format, so nothing about what is signed or how it is unlocked is simulated.
 */
const keyTemplates = new Map<string, Promise<{ keysDir: string; keyHash: string }>>();
function keyTemplate(passphrase: string | undefined): Promise<{ keysDir: string; keyHash: string }> {
  const id = passphrase ?? '';
  let made = keyTemplates.get(id);
  if (!made) {
    made = (async () => {
      const templateHome = newHome();
      const run = await certen(['--json', 'keys', 'generate', '--name', 'dev', ...(passphrase ? [] : ['--no-passphrase'])], {
        home: templateHome, apiUrl: 'http://127.0.0.1:9', env: passphrase ? { CERTEN_KEY_PASSPHRASE: passphrase } : {},
      });
      return { keysDir: join(templateHome, '.certen', 'keys'), keyHash: envelope(run).data!.public_key_hash as string };
    })();
    keyTemplates.set(id, made);
  }
  return made;
}

export async function sendEnv(options: SendEnvOptions = {}): Promise<SendEnv> {
  const gateway = (await startFakeGateway(options.gateway ?? {})) as FakeGateway;
  const home = newHome();
  const certenDir = join(home, '.certen');
  mkdirSync(certenDir, { recursive: true });
  writeFileSync(join(certenDir, 'config.json'), JSON.stringify({
    api_key: 'ck_live_send_test_not_a_real_key', storage: 'file', api_url: gateway.url,
    ...(options.noIdentity ? {} : { identities: [{ id: IDS.identity, adi_url: IDS.adi, chains: ['base-sepolia'], created_at: '2026-10-15T00:00:00Z', name: 'journey-probe' }] }),
  }, null, 2), { mode: 0o600 });

  const env = options.passphrase ? { CERTEN_KEY_PASSPHRASE: options.passphrase } : {};
  // With no key made here, the key page lists one that nobody on this machine holds.
  let keyHash = 'ee'.repeat(32);
  if (!options.noKey) {
    const template = await keyTemplate(options.passphrase);
    cpSync(template.keysDir, join(certenDir, 'keys'), { recursive: true });
    keyHash = template.keyHash;
  }
  for (const name of options.extraKeys ?? []) await certen(['keys', 'generate', '--name', name, '--no-passphrase'], { home, apiUrl: gateway.url });
  gateway.adoptIdentity(keyHash);
  if (options.funded !== false) gateway.fundAbstractAccount();
  gateway.take();

  return {
    home, gateway, keyHash,
    run: (args, opts = {}) => certen(args, { home, apiUrl: gateway.url, env: { ...env, ...opts.env }, input: opts.input, timeoutMs: opts.timeoutMs }),
    close: () => gateway.close(),
  };
}

/** The receipts saved in a home, by file name. */
export function savedReceipts(home: string): string[] {
  const dir = join(home, '.certen', 'receipts');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
}

export function readSavedReceipt(home: string, intentId: string = INTENT_ID): Record<string, any> {
  return JSON.parse(readFileSync(join(home, '.certen', 'receipts', `${intentId}.json`), 'utf8'));
}
