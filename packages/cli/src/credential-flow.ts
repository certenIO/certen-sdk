import { CertenClient, CertenError } from '@certen.io/sdk';
import { getApiKey, getPortalUrl, setApiKey } from './config.js';
import { UsageError } from './errors.js';
import { promptSecret, readSecretFromStdin } from './passphrase.js';
import { runDeviceFlow } from './commands/signup.js';

/**
 * Getting a credential onto this machine: the pieces `init` and `setup` both need, written once.
 *
 * `init` had them inline. `setup` needs the same two (sign in through the browser; fall back to pasting a key when the gateway cannot do device
 * authorization) and a copy would drift from the original in exactly the place the original was careful: a pasted key is verified BEFORE it is
 * stored, because a key that does not work must not be written and then tripped over by every step after it.
 */

export interface AcquiredCredential {
  apiKey: string;
  /** What to say about it in a step list: `sk_live_abc... authorized`. */
  detail: string;
  via: 'device' | 'paste';
}

/**
 * Sign this machine in with the device flow, and when the gateway cannot do that, with a pasted key.
 *
 * The device flow is the point: it used to send people to a browser to copy a secret back by hand. A paste prompt is only the fallback for a
 * gateway without device authorization (`DEVICE_FLOW_UNSUPPORTED`, `SELF_SERVICE_DISABLED`); any other failure (a denied or expired code, an
 * unreachable gateway) is rethrown untouched so its exit code is the right one.
 *
 * `say` receives each progress line without indentation; the caller lays it out.
 */
export async function deviceFlowOrPaste(opts: {
  apiUrl: string;
  keyring: boolean;
  browser: boolean;
  say: (message: string) => void;
}): Promise<AcquiredCredential> {
  try {
    const granted = await runDeviceFlow({ browser: opts.browser, keyring: opts.keyring });
    return { apiKey: await getApiKey(), detail: `${granted.prefix}... authorized`, via: 'device' };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'DEVICE_FLOW_UNSUPPORTED' && code !== 'SELF_SERVICE_DISABLED') throw err;
  }

  opts.say(`this gateway cannot authorize devices. Mint a key at ${getPortalUrl()}`);
  const entered = process.stdin.isTTY
    ? await promptSecret('     Paste your API key (hidden): ')
    : await readSecretFromStdin();
  if (!entered) throw new UsageError('No API key entered.', 'NO_API_KEY');

  // Verified before it is stored, exactly as `auth login` does.
  const probe = new CertenClient({ apiKey: entered, baseUrl: opts.apiUrl });
  try {
    await probe.billing.balance();
  } catch (probeErr) {
    if (probeErr instanceof CertenError && probeErr.status === 401) {
      throw new UsageError(`That API key was rejected by ${opts.apiUrl}. Nothing was saved.`, 'INVALID_API_KEY');
    }
    if (probeErr instanceof CertenError && probeErr.status === 0) throw probeErr;
    // 403 and other statuses mean the credential is real; carry on.
  }
  await setApiKey(entered, opts.keyring);
  return { apiKey: entered, detail: `${entered.substring(0, 12)}... saved`, via: 'paste' };
}

/**
 * Register the wallet the person pays from, so deposits from it credit the organisation on sight (no payment intent, no exact-amount match).
 *
 * Never fails the caller: everything before it has already succeeded, and a 409 only means the address is already attributed, to this
 * organisation or another.
 */
export async function registerPayer(
  client: CertenClient,
  chain: string,
  address: string,
): Promise<{ ok: true } | { ok: false; why: string }> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new UsageError(`"${address}" is not an address. Expected 0x followed by 40 hex characters.`, 'INVALID_PAYER_ADDRESS');
  }
  return client.billing
    .registerPayerAddress({ chain, address })
    .then(() => ({ ok: true as const }))
    .catch((err: unknown) => ({
      ok: false as const,
      why: err instanceof CertenError && err.status === 409
        ? 'already registered — to this organization, or to another one'
        : err instanceof Error ? err.message : String(err),
    }));
}
