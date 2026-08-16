import { Command } from 'commander';
import { CertenClient } from '@certen.io/sdk';
import type { Identity, IdentityResponse } from '@certen.io/sdk';
import { getApiKey, getApiUrl, getOutputFormat, rememberIdentity, forgetIdentity } from '../config.js';
import { printOutput, hint, human, isJsonMode } from '../output.js';
import { resolveSigner } from '../signer.js';
import { assertChain, assertChains } from '../chains.js';
import { UsageError } from '../errors.js';
import { resolveWait, parseWaitBudget, waitForIdentity, IDENTITY_WAIT } from '../wait.js';
import { faucetFor } from '../funding-guard.js';

async function getClient(): Promise<CertenClient> {
  return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
}

/**
 * Render an identity for whoever is reading.
 *
 * Machine consumers get the response verbatim — same keys whether or not the command waited, so
 * nothing has to branch on which flags were passed. Humans get the six fields that decide what to
 * do next, because the table renderer serialises any nested object to a single JSON line: the raw
 * response arrived as one unreadable blob with `can_sign` — the field that determines whether the
 * identity works at all — buried in the middle of it.
 *
 * Table output is explicitly not a contract (docs/CLI-CONTRACT.md), which is what makes this
 * divergence safe.
 */
function printIdentity(response: IdentityResponse): void {
  // One parameter, not two. It took a `response` and an `identity` back when the gateway nested the
  // identity inside the response; now that the response carries those fields itself, passing both
  // would be passing the same object twice — and the JSON branch below re-attached the inner object
  // under an `identity` key, reintroducing the shape on the machine interface after the API had
  // dropped it.
  if (isJsonMode() || getOutputFormat() === 'json') {
    printOutput({ ...response } as unknown as Record<string, unknown>);
    return;
  }
  printOutput({
    id: response.id,
    adi_url: response.adi_url,
    status: response.status,
    // `?? 'unknown'` is load-bearing: `can_sign` is three-valued and null means the key page could
    // not be read. Printing an empty cell would read as "no".
    can_sign: response.can_sign ?? 'unknown',
    key_page_url: response.key_page_url ?? '-',
    credit_balance: response.credit_balance,
  });
}

export function registerIdentityCommands(program: Command): void {
  const identity = program.command('identity').description('Identity management');

  identity
    .command('create')
    .description('Create a new identity')
    .requiredOption('--name <name>', 'Identity name')
    .option('--sign-with <key>', 'Local key to own this identity (see `certen keys generate`)')
    .option('--public-key-hash <hash>', 'Public key hash (omit when using --sign-with)')
    .option('--public-key <key>', 'Public key (hex)')
    .option('--chains <chains>', 'Comma-separated chains, e.g. base-sepolia,arbitrum-sepolia')
    .option('--credits <credits>', 'Initial credits', parseInt)
    // Creation is asynchronous and the response says nothing about whether the identity works.
    // Human mode waits; --json keeps the old fire-and-forget default so existing scripts do not
    // silently start blocking. See resolveWait().
    .option('--wait', 'Wait until the identity is provisioned AND can sign (default off --json)')
    .option('--no-wait', 'Return as soon as the gateway accepts the request')
    .option('--timeout <minutes>', `How long to wait (default ${IDENTITY_WAIT.timeoutMin})`)
    .option('--poll-interval <seconds>', `How often to check (default ${IDENTITY_WAIT.intervalSec})`)
    .action(async (opts) => {
      // --public-key-hash was required, which is why the CLI could not create an identity on its
      // own: the hash is sha256 of the RAW 32-byte public key, and working that out was left to
      // the user. --sign-with derives both fields from a stored key so the common case needs
      // neither. The explicit flags still work for a key this machine does not hold.
      let publicKeyHash: string | undefined = opts.publicKeyHash;
      let publicKey: string | undefined = opts.publicKey;

      // Chains are validated BEFORE the signer is unlocked and before the request goes out. A
      // typo'd chain used to reach the gateway and come back as a rejection with no visible link
      // to the flag that caused it — after the passphrase prompt, which made the round trip worse.
      const chains = opts.chains ? assertChains(opts.chains) : undefined;
      // Same reasoning for the wait options: a typo'd --timeout must not be discovered after an
      // identity has already been created and has already consumed a slot against the org quota.
      const wait = resolveWait();
      const budget = parseWaitBudget(opts.timeout, opts.pollInterval, IDENTITY_WAIT);

      if (opts.signWith) {
        if (publicKeyHash || publicKey) {
          throw new UsageError(
            'Pass either --sign-with or --public-key-hash/--public-key, not both.',
            'CONFLICTING_KEY_FLAGS',
          );
        }
        const signer = await resolveSigner(opts.signWith);
        publicKeyHash = signer.publicKeyHash;
        publicKey = signer.publicKey;
      }

      if (!publicKeyHash) {
        throw new UsageError(
          'Provide --sign-with <key>, or --public-key-hash <hash>. '
          + 'To make a key: certen keys generate --name dev',
          'MISSING_SIGNING_KEY',
        );
      }

      const client = await getClient();
      const result = await client.identity.create({
        name: opts.name,
        publicKeyHash,
        publicKey,
        chains,
        credits: opts.credits,
      });
      const id = result.id;
      // Recorded the moment it exists. The gateway has no identity list route and the portfolio
      // view returns no UUIDs, so an id that is only printed is an id that can be lost.
      if (id) rememberIdentity({ id, adi_url: result.adi_url, chains: chains ?? [] });

      if (!wait || !id) {
        if (result.id) printIdentity(result);
        else printOutput(result as unknown as Record<string, unknown>);
        hint('');
        hint('Provisioning continues in the background. It is not usable until status is terminal');
        hint('AND can_sign is true:');
        hint(`  certen identity get ${id ?? '<id>'}`);
        return;
      }

      // Waiting means the printed result is the one the user can act on, not the 202. Emitting
      // both would put two payloads in the --json envelope for no benefit.
      //
      // The SHAPE stays identical to the no-wait response, because a consumer must not have to
      // parse two different layouts depending on which flags were passed.
      const identity = await waitForIdentity(client, id, budget);
      // Merged, not replaced. `result` carries fields that only the create returns —
      // `mnemonic_retrieval`, `status_url`, `warning` — and `identity` carries the refreshed state.
      // Printing `identity` alone would drop the one-shot mnemonic URL for provider-mode
      // identities, which cannot be recovered afterwards.
      printIdentity({ ...result, ...identity });

      if (isJsonMode()) return;

      human('');
      human(`  Identity ${identity.adi_url} is active and can sign.`);
      human(`  ID  ${identity.id}`);

      // The abstract account is msg.sender for everything this identity executes, and it starts
      // empty. It was previously buried in a JSON blob under a name that does not say so, which
      // is how the "parks at anchoring forever" failure finds people.
      const accounts = identity.chain_accounts ?? [];
      if (accounts.length > 0) {
        human('');
        human('  Abstract accounts (msg.sender on chain — these need gas before they can execute):');
        for (const account of accounts) {
          human(`    ${account.chain_id.padEnd(18)} ${account.address || '(not deployed)'}`);
        }
        const faucets = accounts.map((a) => faucetFor(a.chain_id)).filter(Boolean);
        if (faucets.length > 0) {
          human('');
          human(`  Fund them: ${[...new Set(faucets)].join('  ')}`);
        }
      }

      hint('');
      hint(`Next: certen tx create --identity ${identity.id} --to-chain <chain> --to <addr> --amount <n> --sign-with <key>`);
    });

  identity
    .command('list')
    .description('List the identities in your organization (via the portfolio view)')
    .action(async () => {
      // This called GET /v1/identities, which 404s: the gateway serves /v1/identity (POST) and
      // /v1/identity/{id} (GET/PATCH/DELETE) and has no collection route. It then spent a release
      // as a command whose only behaviour was to explain that it did not work — honest, but the
      // user's actual question ("what identities do I have") was answerable the whole time from
      // /v1/portfolio.
      //
      // It then spent a release answering that question WITHOUT the ids, because the portfolio view
      // withheld them — so anyone who had lost the UUID printed at create time could see their
      // identity listed and still not act on it. The gateway now returns `id` there (it had it in
      // hand all along), and this command is finally a complete answer rather than a partial one
      // with a footnote.
      const client = await getClient();
      const portfolio = await client.portfolio.get();
      const identities = portfolio.identities ?? [];

      if (identities.length === 0) {
        printOutput([]);
        hint('No identities yet. Create one: certen identity create --name <name> --sign-with <key>');
        return;
      }

      // `id` first: it is the field every other command takes as an argument, so it is the one a
      // reader is scanning for.
      printOutput(identities.map((i) => ({
        id: i.id ?? '—',
        adi_url: i.adi_url,
        status: i.status,
        credit_balance: i.credit_balance,
        chains: i.chains?.length ?? 0,
        pending_actions: i.pending_actions,
      })));

      // A gateway older than 2026-08 does not return `id` here, and the CLI ships independently of
      // it. Say so only when it is actually true — a permanent caveat about a fixed problem trains
      // people to skip the notes that matter.
      if (identities.some((i) => !i.id)) {
        hint('');
        hint('This gateway does not return identity ids in the portfolio view, so `id` reads "—".');
        hint('Upgrade the gateway, or use the id printed when the identity was created.');
      }
    });

  identity
    .command('get <id>')
    .description('Get identity details')
    .action(async (id: string) => {
      const client = await getClient();
      // No `--include`: the route takes no query parameters. It used to be sent and silently ignored.
      const result = await client.identity.get(id);
      printIdentity(result);

      if (isJsonMode()) return;
      const identity = result;

      // `can_sign` is the field that decides whether this identity is usable, and reading it out
      // of a printed blob is exactly the step people skip. State the conclusion.
      if (identity.can_sign === true) {
        hint('');
        hint(`Ready. Next: certen tx create --identity ${identity.id} --to-chain <chain> --to <addr> --amount <n> --sign-with <key>`);
      } else if (identity.can_sign === false) {
        hint('');
        hint('This identity CANNOT sign — its key page is not held by your key. It will fail at the');
        hint('signing step of every flow.');
      } else if (['provisioning', 'pending', 'creating'].includes(identity.status)) {
        hint('');
        hint(`Still provisioning. Wait for it: certen identity get ${identity.id}`);
      } else {
        // null on a terminal status: unknown, not a soft yes. Never round it up.
        hint('');
        hint('Whether this identity can sign is UNKNOWN — its on-chain key page could not be read.');
        hint('Treat it as unusable until that resolves.');
      }
    });

  identity
    .command('retire <id>')
    .description('Retire an identity, freeing the org quota slot it occupies')
    .requiredOption('--yes', 'Confirm. There is no prompt — see below')
    .action(async (id: string) => {
      // No y/N prompt: the required --yes IS the confirmation, matching `keys delete`. An identity
      // that a live integration depends on should not be retirable by an accidental Enter.
      const client = await getClient();

      // Resolved first so the confirmation message names what is being retired. An id pasted from
      // the wrong terminal is the mistake worth catching, and it is invisible until something says
      // the ADI out loud.
      // No enrichments: this read exists to name the ADI in the confirmation prompt. Fetching
      // governance, per-chain balances and pending counts to print one URL is work nobody sees.
      const before = await client.identity.get(id, { include: [] }).catch(() => null);

      const result = await client.identity.retire(id);
      // Dropped from the local record too, so `certen init` does not offer to reuse it.
      forgetIdentity(id);
      printOutput(result as unknown as Record<string, unknown>);

      if (isJsonMode()) return;
      human('');
      human(`  Retired ${before?.adi_url ?? id}. The org quota slot is free.`);
      human('');
      // The distinction people get wrong, and the one that matters if they were retiring for
      // security reasons rather than housekeeping.
      human('  This is a soft delete INSIDE CERTEN. The on-chain ADI, its key book and its key page');
      human('  still exist on Accumulate and are untouched. Retiring is not a way to revoke a key.');
    });

  identity
    .command('link-chain <id>')
    .description('Link a chain to an identity')
    .requiredOption('--chain <chain>', 'Chain to link, e.g. base-sepolia')
    .action(async (id: string, opts) => {
      const chain = assertChain(opts.chain);
      const client = await getClient();
      const result = await client.identity.update(id, {
        linkChains: [chain],
      });
      printOutput(result as unknown as Record<string, unknown>);
    });
}
