import { Command } from 'commander';
import { CertenClient } from '@certen.io/sdk';
import type { Identity, IdentityResponse } from '@certen.io/sdk';
import { getApiKey, getApiUrl, getOutputFormat } from '../config.js';
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
function printIdentity(response: IdentityResponse, identity: Identity): void {
  if (isJsonMode() || getOutputFormat() === 'json') {
    printOutput({ ...response, identity } as unknown as Record<string, unknown>);
    return;
  }
  printOutput({
    id: identity.id,
    adi_url: identity.adi_url,
    status: identity.status,
    can_sign: identity.can_sign ?? 'unknown',
    key_page_url: identity.key_page_url ?? '-',
    credit_balance: identity.credit_balance,
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
      const id = result.identity?.id;

      if (!wait || !id) {
        if (result.identity) printIdentity(result, result.identity);
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
      // The SHAPE stays identical to the no-wait response — the create envelope with a refreshed
      // `identity` — because a consumer must not have to parse two different layouts depending on
      // which flags were passed. Printing the bare identity here would have done exactly that.
      const identity = await waitForIdentity(client, id, budget);
      printIdentity(result, identity);

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
      // /v1/portfolio. So answer it, and note the one thing that view genuinely cannot give.
      const client = await getClient();
      const portfolio = await client.portfolio.get();
      const identities = portfolio.identities ?? [];

      if (identities.length === 0) {
        printOutput([]);
        hint('No identities yet. Create one: certen identity create --name <name> --sign-with <key>');
        return;
      }

      printOutput(identities.map((i) => ({
        adi_url: i.adi_url,
        status: i.status,
        credit_balance: i.credit_balance,
        chains: i.chains?.length ?? 0,
        pending_actions: i.pending_actions,
      })));

      // The gap is real and worth naming: /v1/portfolio keys identities by ADI URL and does not
      // return the UUID that `identity get` takes. Someone who did not record the ID at create
      // time cannot recover it here, and pretending otherwise would send them looking for a
      // column that does not exist.
      hint('');
      hint('Note: the gateway has no identity collection route, so this comes from `certen portfolio`.');
      hint('It shows ADI URLs, not the UUIDs `certen identity get` takes — those are printed at create time.');
    });

  identity
    .command('get <id>')
    .description('Get identity details')
    .action(async (id: string) => {
      const client = await getClient();
      // No `--include`: the route takes no query parameters. It used to be sent and silently ignored.
      const result = await client.identity.get(id);
      printIdentity(result, result.identity);

      if (isJsonMode()) return;
      const identity = result.identity;

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
