import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { agentBookDisableOperation, cancelByRejectVote, replaceAgent, revokeAgentKey, revokeGrant, revokeSeatRecord, EXPOSURE_WINDOW_STATEMENT } from '@certen.io/sdk';
import { CertenClient, CertenError, agentEnrollmentState, agentAuthorityOperation, buildPrincipalEntry, writePrincipalEntry, type AgentEnrollmentFacts, type PrincipalEntryKind } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { confirmBeforeSigning } from '../card.js';
import { resolveSigner } from '../signer.js';
import { printOutput } from '../output.js';
import { CliError, UsageError, EXIT } from '../errors.js';
import { submitGovernance } from './governance.js';

/**
 * `certen agent` - agent enrollment (AGT-2 WP1; transaction-controls docs/agentic/AGENT-IDENTITY.md section 3).
 *
 * `enroll-status` decides the enrollment state from chain facts and names the next step; it signs nothing.
 * `add-authority` carries out the agent's own step (name the principal's book as a required authority on the agent ADI or its
 * key book). It signs ONLY with an explicit `--sign-with` key: no context key, no only-key default, and `--json`, `--yes` or a
 * pipe never make it sign without one (standard fact F9). The principal's acceptance of that authority is the principal's
 * signature on the pending transaction (`certen pending sign`, by the principal), never something the agent's command does.
 */
export function registerAgentCommands(program: Command): void {
  const agent = program.command('agent').description('Agent enrollment: the principal\'s book on the agent ADI and key book, the registry, the Grant and the mandate');

  agent
    .command('enroll-status')
    .description('Decide the enrollment state from chain facts (JSON file) and name the next step; signs nothing')
    .requiredOption('--facts <file>', 'JSON file of AgentEnrollmentFacts read off the chain')
    .option('--require-enrolled', 'Exit 1 unless the agent is enrolled')
    .action((opts: { facts: string; requireEnrolled?: boolean }) => {
      let facts: AgentEnrollmentFacts;
      try {
        facts = JSON.parse(readFileSync(opts.facts, 'utf8')) as AgentEnrollmentFacts;
      } catch (e) {
        throw new UsageError(`enrollment facts unreadable: ${(e as Error).message}`, 'AGENT_FACTS_UNREADABLE');
      }
      const verdict = agentEnrollmentState(facts);
      printOutput(verdict as unknown as Record<string, unknown>);
      if (opts.requireEnrolled && !verdict.enrolled) {
        throw new CliError(`agent not enrolled: ${verdict.state}`, 'AGENT_NOT_ENROLLED', EXIT.FAILED, false, { state: verdict.state, next: verdict.next });
      }
    });

  agent
    .command('add-authority')
    .description('The agent names the principal\'s book as a required authority on its identity or key book (signs only with --sign-with)')
    .requiredOption('--identity <adi>', 'The agent ADI, e.g. acc://agent-7.example.acme')
    .requiredOption('--principal-book <url>', 'The principal\'s key book, e.g. acc://principal.acme/book')
    .requiredOption('--account <which>', 'identity | book')
    .option('--sign-with <key>', 'REQUIRED: the local key on the agent\'s page that signs this step')
    .option('--signer-key-page <url>', 'Sign with a specific page of the agent\'s book')
    .option('--yes', 'Say yes to the confirmation in advance; it never replaces --sign-with')
    .action(async (opts: { identity: string; principalBook: string; account: string; signWith?: string; signerKeyPage?: string; yes?: boolean }) => {
      // Refused before any request or key read: nothing signs without an explicit key (F9).
      if (!opts.signWith) {
        throw new UsageError('agent add-authority signs only with an explicit --sign-with <key>; no context or default key is used (sign_with_required)', 'SIGN_WITH_REQUIRED');
      }
      if (opts.account !== 'identity' && opts.account !== 'book') throw new UsageError('--account must be identity or book', 'USAGE_ERROR');
      let operation: Record<string, string>;
      try {
        operation = agentAuthorityOperation({ agentAdi: opts.identity, principalBook: opts.principalBook }, opts.account);
      } catch {
        throw new UsageError('the agent ADI or the principal book is malformed, or the book lies under the agent itself', 'AGENT_AUTHORITY_MALFORMED');
      }
      await submitGovernance(() => operation, { identity: opts.identity, signWith: opts.signWith, signerKeyPage: opts.signerKeyPage, yes: opts.yes, pinnedAuthority: [opts.principalBook] });
    });

  // ── the principal's side: registry entry, Grant, mandate (AGT-2 WP1, finding AGT-F20) ──
  // Each writes one entry to the principal's own data account through the gateway's two-phase governance route (create_data_account
  // when the account is absent, then write_data). Every signature is the principal's key on the principal's page: the command signs
  // ONLY with an explicit --sign-with key. --json, --yes, a pipe or a key in the environment never make it sign without one (F9).
  const principalCommand = (name: string, kind: PrincipalEntryKind, what: string) => agent
    .command(name)
    .description(`The principal ${what} (signs only with --sign-with)`)
    .requiredOption('--identity <adi>', 'The PRINCIPAL ADI, e.g. acc://harbor-mfg.acme')
    .requiredOption('--document <file>', `JSON file of the ${kind} document`)
    .option('--sign-with <key>', "REQUIRED: the local key on the principal's page that signs the entry and its transactions")
    .option('--signer-key-page <url>', "The principal's page that signs (default <identity>/book/1)")
    .option('--yes', 'Say yes to the confirmation in advance; it never replaces --sign-with')
    .action(async (opts: { identity: string; document: string; signWith?: string; signerKeyPage?: string; yes?: boolean }) => {
      // Refused before any file, key or request is read: nothing signs without an explicit key (F9).
      if (!opts.signWith) throw new UsageError(`agent ${name} signs only with an explicit --sign-with <key>; no context, environment or default key is used (sign_with_required)`, 'SIGN_WITH_REQUIRED');
      let document: unknown;
      try {
        document = JSON.parse(readFileSync(opts.document, 'utf8'));
      } catch (e) {
        throw new UsageError(`the ${kind} document is unreadable: ${(e as Error).message}`, 'PRINCIPAL_DOCUMENT_UNREADABLE');
      }
      const principal = opts.identity.toLowerCase().replace(/\/+$/, '');
      const page = (opts.signerKeyPage ?? `${principal}/book/1`).toLowerCase();
      // The entry is built (and refused) before any key is opened or request made: the person then reads the account and the payload hash.
      let preview: ReturnType<typeof buildPrincipalEntry>;
      try {
        preview = buildPrincipalEntry({ kind, principal, page, document, signer: { publicKey: '00'.repeat(32), sign: () => '00'.repeat(64) } });
      } catch (e) {
        if (e instanceof CertenError) {
          if (e.code === 'PRINCIPAL_ENTRY_NOT_PRINCIPALS') throw new UsageError(e.message, 'PRINCIPAL_ENTRY_NOT_PRINCIPALS');
          if (e.code === 'PRINCIPAL_PAGE_INVALID') throw new UsageError(e.message, 'PRINCIPAL_PAGE_INVALID');
          if (e.code === 'PRINCIPAL_ENTRY_REFUSED_BY_CORE') throw new UsageError(e.message, 'PRINCIPAL_ENTRY_REFUSED_BY_CORE');
          throw new UsageError(e.message, 'PRINCIPAL_ENTRY_MALFORMED');
        }
        throw e;
      }
      const signer = await resolveSigner(opts.signWith);
      await confirmBeforeSigning({
        headline: `Write the ${kind} of ${principal} to ${preview.account}`,
        rows: [['account', preview.account], ['payload', `${preview.tag} ${preview.hash}`], ['signed by', `${page} (${signer.publicKey.slice(0, 16)}...)`]],
        keyName: opts.signWith,
      } as never, { yes: opts.yes });
      const client = new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
      const r = await writePrincipalEntry(client, { kind, principal, page, document, signer: { publicKey: signer.publicKey, sign: (h: string) => signer.sign(h) } });
      printOutput({ account: r.entry.account, payloadTag: r.entry.tag, payloadHash: r.entry.hash, accountCreated: r.accountCreated, createTx: r.createTx ?? null, writeTx: r.writeTx ?? null, writeOperationId: r.writeOperationId });
    });
  principalCommand('register', 'registration', 'registers its agent in its registry (certen-subjects, subject type agent)');
  principalCommand('issue-grant', 'grant', "issues the agent's Grant (certen-grants)");
  principalCommand('issue-mandate', 'mandate', "signs the agent's mandate (certen-mandates)");

  // ── AGT-3: revoke, cancel by reject vote, replace (the principal's person-held acts; docs/agentic/INTERVENTION.md) ──
  // Each signs ONLY with an explicit --sign-with key (F9) and prints the exposure-window truth (DEC-2): before final approval a required
  // authority's reject vote or key removal stops the action; after certification exposure is limited to the exact approved action inside
  // its window; there is no on-chain cancel. Each prints `seatRecord` (AGT-F135): the form the named person submits at the seat
  // (POST /agents/interventions) so the act is recorded in the seat's decision log; the CLI holds no person session and records nothing there.
  const exposure = `Exposure window: ${EXPOSURE_WINDOW_STATEMENT}`;
  const intervention = (cmd: Command) => cmd
    .requiredOption('--seat <seat>', 'The named seat that acts, e.g. seat:harbor-supervisor')
    .requiredOption('--reason <text>', 'Why, in at least 10 characters')
    .option('--sign-with <key>', "REQUIRED: the local key that signs (the principal's, or for cancel the required authority's)")
    .option('--yes', 'Say yes to the confirmation in advance; it never replaces --sign-with');
  const needKey = (name: string, signWith: string | undefined) => {
    if (!signWith) throw new UsageError(`agent ${name} signs only with an explicit --sign-with <key>; no context, environment or default key is used (sign_with_required). ${exposure}`, 'SIGN_WITH_REQUIRED');
  };
  const readDoc = (file: string, what: string): unknown => {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new UsageError(`the ${what} is unreadable: ${(e as Error).message}`, 'PRINCIPAL_DOCUMENT_UNREADABLE'); }
  };
  const asUsage = (e: unknown): never => {
    if (e instanceof CertenError && e.code === 'INTERVENTION_MALFORMED') throw new UsageError(e.message, 'INTERVENTION_MALFORMED');
    throw e;
  };
  const clientNow = async () => new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });

  intervention(agent
    .command('revoke')
    .description(`Revoke an agent: supersede its Grant with an empty validity and, with --agent-page, remove its key with the owner's page (signs only with --sign-with). ${EXPOSURE_WINDOW_STATEMENT}`)
    .requiredOption('--identity <adi>', 'The PRINCIPAL ADI')
    .requiredOption('--grant <file>', 'JSON file of the Grant head being revoked')
    .option('--agent-page <url>', "The agent's key page whose key the owner removes")
    .option('--agent-key-hash <hex>', "sha256 of the agent's key on that page")
    .option('--revocation-key-hash <hex>', 'sha256 of an OWNER-held key added to the agent page in the same transaction (Accumulate refuses to delete the last key of page 1)')
    .option('--signer-key-page <url>', "The principal's page that signs (default <identity>/book/1)"))
    .action(async (opts: { identity: string; grant: string; agentPage?: string; agentKeyHash?: string; revocationKeyHash?: string; signerKeyPage?: string; seat: string; reason: string; signWith?: string; yes?: boolean }) => {
      needKey('revoke', opts.signWith);
      if (Boolean(opts.agentPage) !== Boolean(opts.agentKeyHash) || Boolean(opts.agentPage) !== Boolean(opts.revocationKeyHash)) throw new UsageError('--agent-page, --agent-key-hash and --revocation-key-hash go together', 'INTERVENTION_MALFORMED');
      const head = readDoc(opts.grant, 'Grant');
      const principal = opts.identity.toLowerCase().replace(/\/+$/, '');
      const page = (opts.signerKeyPage ?? `${principal}/book/1`).toLowerCase();
      const signer = await resolveSigner(opts.signWith!);
      await confirmBeforeSigning({ headline: `Revoke the agent Grant of ${principal}`, rows: [['seat', opts.seat], ['reason', opts.reason], ['exposure', EXPOSURE_WINDOW_STATEMENT]], keyName: opts.signWith } as never, { yes: opts.yes });
      const client = await clientNow();
      const sign = { publicKey: signer.publicKey, sign: (h: string) => signer.sign(h) };
      const grant = await revokeGrant(client, { principal, page, head, signer: sign, seat: opts.seat, reason: opts.reason }).catch(asUsage);
      const key = opts.agentPage ? await revokeAgentKey(client, { principal, page, agentPage: opts.agentPage, keyHash: opts.agentKeyHash!, revocationKeyHash: opts.revocationKeyHash!, signer: sign, seat: opts.seat, reason: opts.reason }).catch(asUsage) : null;
      const record = key ? revokeSeatRecord(grant, key) : grant;
      printOutput({ grant: { account: grant.entry.account, payloadHash: grant.entry.hash, writeTx: grant.writeTx ?? null }, key: key ? { agentPage: key.agentPage, txHash: key.txHash ?? null } : null, seat: opts.seat, reason: opts.reason, exposureWindow: EXPOSURE_WINDOW_STATEMENT, seatRecord: record.seatRecord, recordedAtSeat: record.recordedAtSeat, seatRecordStatement: record.seatRecordStatement });
    });

  // AGT-F28: the enrollment step that disables the agent's OWN book as an authority of its key book (the agent proposes, the principal
  // co-signs the pending transaction: UpdateAccountAuth needs every authority's vote). Signs only with --sign-with.
  agent
    .command('disable-book')
    .description("The agent proposes disabling its own book as an authority of its key book, so key-page changes need the principal alone (signs only with --sign-with)")
    .requiredOption('--identity <adi>', 'The agent ADI')
    .option('--sign-with <key>', "REQUIRED: the local key on the agent's page")
    .option('--signer-key-page <url>', "Sign with a specific page of the agent's book")
    .option('--yes', 'Say yes to the confirmation in advance; it never replaces --sign-with')
    .action(async (opts: { identity: string; signWith?: string; signerKeyPage?: string; yes?: boolean }) => {
      if (!opts.signWith) throw new UsageError('agent disable-book signs only with an explicit --sign-with <key>; no context or default key is used (sign_with_required)', 'SIGN_WITH_REQUIRED');
      let operation: Record<string, string>;
      try { operation = agentBookDisableOperation(opts.identity.toLowerCase().replace(/\/+$/, '')); } catch { throw new UsageError('the agent ADI is malformed', 'AGENT_AUTHORITY_MALFORMED'); }
      await submitGovernance(() => operation, { identity: opts.identity, signWith: opts.signWith, signerKeyPage: opts.signerKeyPage, yes: opts.yes });
    });

  intervention(agent
    .command('cancel <tx>')
    .description(`Cancel a pending transaction by a REJECT vote of a required authority (signs only with --sign-with). ${EXPOSURE_WINDOW_STATEMENT}`)
    .requiredOption('--identity <adi>', 'The identity the vote is cast as')
    .requiredOption('--subject <adi>', "The agent ADI whose pending transaction is rejected (the seat record's subject)")
    .requiredOption('--signer-url <url>', "The required authority's key page that votes"))
    .action(async (tx: string, opts: { identity: string; subject: string; signerUrl: string; seat: string; reason: string; signWith?: string; yes?: boolean }) => {
      needKey('cancel', opts.signWith);
      const signer = await resolveSigner(opts.signWith!);
      await confirmBeforeSigning({ headline: `Cast a REJECT vote on pending transaction ${tx}`, rows: [['seat', opts.seat], ['reason', opts.reason], ['exposure', EXPOSURE_WINDOW_STATEMENT]], keyName: opts.signWith } as never, { yes: opts.yes });
      const r = await cancelByRejectVote(await clientNow(), { identity: opts.identity, subject: opts.subject, txHash: tx, signerUrl: opts.signerUrl, signer: { publicKey: signer.publicKey, sign: (h: string) => signer.sign(h) }, seat: opts.seat, reason: opts.reason }).catch(asUsage);
      printOutput(r as unknown as Record<string, unknown>);
    });

  intervention(agent
    .command('replace')
    .description(`Replace an agent: retire its registration, register the new agent and issue its own Grant (signs only with --sign-with). ${EXPOSURE_WINDOW_STATEMENT}`)
    .requiredOption('--identity <adi>', 'The PRINCIPAL ADI')
    .requiredOption('--retire <file>', "JSON file of the old agent's next registration version, status retired")
    .requiredOption('--register <file>', 'JSON file of the new agent registration')
    .requiredOption('--grant <file>', "JSON file of the new agent's Grant")
    .option('--signer-key-page <url>', "The principal's page that signs (default <identity>/book/1)"))
    .action(async (opts: { identity: string; retire: string; register: string; grant: string; signerKeyPage?: string; seat: string; reason: string; signWith?: string; yes?: boolean }) => {
      needKey('replace', opts.signWith);
      const [retiredRegistration, newRegistration, newGrant] = [readDoc(opts.retire, 'retired registration'), readDoc(opts.register, 'new registration'), readDoc(opts.grant, 'new Grant')];
      const principal = opts.identity.toLowerCase().replace(/\/+$/, '');
      const page = (opts.signerKeyPage ?? `${principal}/book/1`).toLowerCase();
      const signer = await resolveSigner(opts.signWith!);
      await confirmBeforeSigning({ headline: `Replace an agent of ${principal}`, rows: [['seat', opts.seat], ['reason', opts.reason], ['exposure', EXPOSURE_WINDOW_STATEMENT]], keyName: opts.signWith } as never, { yes: opts.yes });
      const r = await replaceAgent(await clientNow(), { principal, page, signer: { publicKey: signer.publicKey, sign: (h: string) => signer.sign(h) }, retiredRegistration, newRegistration, newGrant, seat: opts.seat, reason: opts.reason }).catch(asUsage);
      printOutput({ retired: r.retired.entry.hash, registered: r.registered.entry.hash, grant: r.grant.entry.hash, seat: r.seat, reason: r.reason, exposureWindow: r.exposureWindow, seatRecord: r.seatRecord, recordedAtSeat: r.recordedAtSeat, seatRecordStatement: r.seatRecordStatement });
    });
}
