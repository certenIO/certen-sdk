import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { CertenClient, CertenError, fetchSharedProof, decodeSharedBundle, executionComponentOf, verifyExecutionProof, type ChainReceipt } from '@certen.io/sdk';
import { verifyBundle, loadProofEvidence, bundleInputOf, type BundleVerification } from '@certen.io/sdk/verify';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput, human, isJsonMode } from '../output.js';
import { CliError, UsageError, EXIT } from '../errors.js';

/**
 * `certen proof verify`: check a proof, layer by layer, from its own bytes.
 *
 * The verdict comes from `@certen.io/sdk/verify` (and under it `@certen.io/proof-verify`) running here, on the document the
 * caller supplied or the gateway served. It is never read from a flag in the bundle: the bundle's own `verified` is printed as
 * the validators' statement and nothing more. Exit codes:
 *
 *   0  verified: every layer the document carries was checked here
 *   1  failed: a layer was checked and does not hold, or the input cannot be read
 *   2  usage error
 *   3  the gateway could not be reached (unchanged; nothing to do with the proof)
 *   4  partial: checked what is in the document, but a layer is not established (named)
 *   5  no evidence: nothing the Accumulate side can be checked from (PROOF_V2_EVIDENCE_NOT_SERVED for a live proof)
 */

const short = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 22 && /^(0x)?[0-9a-f]+$/i.test(s) ? `${s.slice(0, 12)}…${s.slice(-6)}` : s;
};

const MARK: Record<string, string> = { verified: 'verified    ', failed: 'FAILED      ', not_checked: 'NOT CHECKED ', not_in_document: 'not carried ' };
const OVERALL_LINE: Record<string, string> = {
  verified: 'VERIFIED',
  partial: 'PARTIAL: what the document carries was checked, and the layers below are not established',
  failed: 'FAILED',
  no_evidence: 'NO EVIDENCE: nothing about the Accumulate side could be checked',
};

function exitFor(overall: string): number {
  if (overall === 'verified') return EXIT.OK;
  if (overall === 'failed') return EXIT.FAILED;
  if (overall === 'partial') return EXIT.PARTIAL;
  return EXIT.NO_EVIDENCE;
}

function render(target: string, v: BundleVerification, extra: { gateway: ChainReceipt | null; notServed: { code: string; reason: string } | null }): void {
  human('');
  human(`  Proof ${target}`);
  human(`  Verdict: ${OVERALL_LINE[v.overall] ?? v.overall}`);
  human('');
  for (const l of v.layers) {
    human(`  ${l.id.padEnd(10)} ${MARK[l.verdict]} ${l.title}`);
    if (l.verdict === 'verified') {
      const ev = Object.entries(l.evidence).filter(([, x]) => x !== null && x !== undefined);
      if (ev.length) human(`             ${ev.map(([k, x]) => `${k} ${short(x)}`).join(' · ')}`);
    } else if (l.reason) {
      human(`             ${l.reason}`);
    }
  }
  human('');
  if (v.overall === 'verified') {
    human(`  Checked here from the proof's own bytes, with CERTEN not trusted: ${v.covers.join(', ')}.`);
    human(`  Not covered by this proof: ${v.notCovered.join(', ')}. A valid proof of the WRONG call is still a valid proof: compare the`);
    human('  operation against your own record of what was agreed.');
  } else if (v.overall === 'failed') {
    human(`  FAILED at ${v.failure?.layer}: ${v.failure?.message}. Do not rely on this proof.`);
  } else if (v.overall === 'partial') {
    human('  This is not a verified proof. The layers marked NOT CHECKED rest on someone\'s word until they are established.');
  } else if (extra.notServed) {
    human(`  ${extra.notServed.code}: ${extra.notServed.reason}`);
  }
  const st = v.bundleStatements;
  if (st.verified !== undefined || st.chainedProofVerified !== undefined) {
    human(`  The bundle says verified=${String(st.verified ?? st.chainedProofVerified)}. That is the validators' statement about themselves. It was not used.`);
  }
  if (extra.gateway) {
    human(`  The gateway also reports this transaction as ${extra.gateway.anchored ? 'anchored' : 'NOT anchored'}. That is the gateway answering, not verification, and it was not used.`);
  }
  human('');
}

export function registerProofVerify(proof: Command): void {
  proof
    .command('verify <target>')
    .description('Verify a proof layer by layer, locally. A bundle file or share link is checked with no API key; the verdict never comes from a flag in the bundle.')
    .option('--rpc <url>', 'A JSON-RPC endpoint of the execution chain you trust: the bundle\'s receipts root and block hash are compared to the header it returns')
    .option('--expect <address:topic0[:topic1]>', 'An event the receipt must contain (contract address and event topic, optionally the first indexed argument)')
    .option('--govroot <hex>', 'A govRoot v3 to compare the one computed here with (for example the one an anchor committed)')
    .action(async (target: string, opts: { rpc?: string; expect?: string; govroot?: string }) => {
      const fromFile = target.startsWith('@');
      const fromShare = /^https?:\/\//i.test(target) || /^cps_/.test(target);
      const client = fromFile || fromShare ? null : new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });

      let bundle: Record<string, unknown> | null = null;
      let portable: unknown = null;
      let notServed: { code: string; reason: string } | null = null;
      let gateway: ChainReceipt | null = null;
      let bundleError: string | null = null;

      if (fromShare) {
        const shared = await fetchSharedProof(target);
        bundle = decodeSharedBundle(shared.bundle);
        if (!bundle) throw new CliError('The shared bundle is not JSON this tool can read.', 'UNREADABLE_BUNDLE', EXIT.FAILED);
      } else if (fromFile) {
        const path = target.slice(1);
        try {
          bundle = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        } catch (err) {
          throw new UsageError(`Could not read ${path} as a JSON bundle: ${err instanceof Error ? err.message : String(err)}. A binary bundle cannot be checked locally.`, 'UNREADABLE_BUNDLE');
        }
        bundle = decodeSharedBundle(bundle.bundle ?? bundle) ?? bundle;
      } else {
        const loaded = await loadProofEvidence(client!, target).catch((err) => {
          if (err instanceof CertenError && err.status === 0 && err.code === 'INVALID_PROOF_TARGET') throw new UsageError(err.message, err.code);
          if (err instanceof CertenError && err.status === 0 && err.code === 'NOTHING_TO_VERIFY') throw new CliError(err.message, err.code, EXIT.FAILED);
          throw err;
        });
        ({ bundle, portable, notServed, gateway, bundleError } = loaded);
      }

      // The outcome layer compares the receipts root with a header from the caller's own RPC, so the header is fetched first.
      let expect: { address?: string; topic0?: string; topic1?: string } | undefined;
      if (opts.expect) {
        const [address, topic0, topic1] = opts.expect.split(':');
        expect = { address: address || undefined, topic0: topic0 || undefined, topic1: topic1 || undefined };
      }
      const component = bundle ? executionComponentOf(bundle) : null;
      let header: { hash?: string; receiptsRoot?: string; number?: string } | undefined;
      if (opts.rpc && component) {
        const first = verifyExecutionProof(component, expect);
        if (first.ok) {
          const res = await fetch(opts.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['0x' + first.blockNumber.toString(16), false] }) });
          const j = (await res.json()) as { result?: { hash?: string; receiptsRoot?: string; number?: string } };
          header = j.result ?? { number: '0x' + first.blockNumber.toString(16) }; // a missing block fails the comparison below
        }
      }

      const input = bundleInputOf({ bundle, portable });
      const v = verifyBundle(input, { expect, header, expectGovRoot: opts.govroot });

      if (isJsonMode()) {
        const { report: _report, ...rest } = v;
        void _report;
        printOutput({
          ...rest,
          evidence: { found: v.evidenceFound, ...(notServed ? { code: notServed.code, reason: notServed.reason } : {}), ...(bundleError ? { bundleError } : {}) },
          gateway: gateway ? { anchored: gateway.anchored, tx_hash: gateway.tx_hash, anchor: gateway.receipt?.anchor ?? null, note: 'asked of the gateway; not used in the verdict' } : null,
        } as unknown as Record<string, unknown>);
      } else {
        render(target, v, { gateway, notServed });
      }
      process.exitCode = exitFor(v.overall);
    });
}
