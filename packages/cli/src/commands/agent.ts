import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { agentEnrollmentState, agentAuthorityOperation, type AgentEnrollmentFacts } from '@certen.io/sdk';
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
}
