import type { Receipt, ReceiptStage } from '@certen.io/sdk';
import { human } from './output.js';
import { EXIT, type ExitCode } from './errors.js';

/**
 * Putting a `Receipt` in front of a person, and deciding what exit code it earns.
 *
 * The SDK assembles the record and states, in words, what is established and what is not. This only lays it out, and adds the one thing
 * the SDK cannot: the command to type next, because the SDK does not know it is being driven by a CLI.
 */

const MARK: Record<ReceiptStage['state'], string> = {
  done: 'done', pending: 'wait', failed: 'FAIL', unknown: ' ?? ', skipped: ' -- ',
};

/** The four stages on one line: `[done] signed  [done] anchored on Accumulate  [done] executed on base-sepolia  [ ?? ] proof verified locally`. */
export function stageLine(r: Receipt): string {
  return r.stages.map((s) => `[${MARK[s.state]}] ${s.label}`).join('  ');
}

/**
 * The exit code a receipt earns. 0 means VERIFIED (or an executed action whose proof can never exist, which says so); anything the
 * receipt could not establish is not 0, because a script that reads 0 as "done and checked" must never be told that of a PARTIAL.
 *
 *   0 verified, or `unproven` (nothing can be verified)   1 failed   4 partial or pending   5 no evidence (nothing about the Accumulate side)
 */
export function exitCodeFor(r: Receipt): ExitCode {
  switch (r.verdict) {
    case 'verified':
    case 'unproven':
      return EXIT.OK;
    case 'failed':
      return EXIT.FAILED;
    case 'pending':
      return EXIT.PARTIAL;
    case 'partial':
      return r.proof.verdict === 'no_evidence' ? EXIT.NO_EVIDENCE : EXIT.PARTIAL;
  }
}

/** The command that moves a receipt forward, or undefined when there is nothing left to do. */
export function nextCommand(r: Receipt): string | undefined {
  const id = r.intent_id;
  if (r.verdict === 'pending') return r.status.outcome === 'executed' ? `certen receipt ${id}` : `certen watch ${id}`;
  if (r.verdict === 'partial') {
    const codes = new Set(r.gaps.map((g) => g.code));
    if (codes.has('PROOF_NOT_FETCHED') || codes.has('PROOF_PENDING')) return `certen receipt ${id}`;
    if (codes.has('NODE_NOT_CONSULTED') || codes.has('EFFECT_UNCHECKED') || codes.has('EFFECT_UNREADABLE')) return `certen receipt ${id} --rpc <a node you trust on ${r.ids.destination_chain ?? 'the chain'}>`;
    return `certen receipt ${id} --explain`;
  }
  if (r.verdict === 'verified') return `certen receipt ${id} --share`;
  return undefined;
}

/** The proof's own verdict, in capitals where it is not a pass. PARTIAL and NO EVIDENCE are never dressed as verified. */
export function proofLine(r: Receipt): string {
  const p = r.proof;
  switch (p.verdict) {
    case 'verified': return `VERIFIED: ${p.layers_verified} of ${p.layers_total} layers carried, checked here   (certen receipt ${r.intent_id} --explain)`;
    case 'partial': return `PARTIAL: ${p.detail}   (certen receipt ${r.intent_id} --explain)`;
    case 'failed': return `FAILED: ${p.detail}`;
    case 'no_evidence': return `NO EVIDENCE: ${p.detail}`;
    case 'unavailable': return `NOT CHECKED: ${p.detail}`;
    default: return p.detail;
  }
}

const rowOf = (label: string, value: string): string => `  ${label.padEnd(9)} ${value}`;
const cont = (value: string): string => `  ${' '.repeat(9)} ${value}`;

/** The receipt as lines. Pure. */
export function receiptLines(r: Receipt, opts: { savedTo?: string; explain?: boolean } = {}): string[] {
  const lines: string[] = [''];
  lines.push(`  ${stageLine(r)}`);
  lines.push('');

  const dest = r.ids.destination_chain ?? 'destination';
  lines.push(rowOf('Receipt', `intent          ${r.ids.intent_id}`));
  if (r.ids.accumulate_tx) lines.push(cont(`accumulate tx   ${r.ids.accumulate_tx}`));
  if (r.ids.destination_tx) {
    const from = r.ids.destination_tx_source === 'proof' ? 'from the verified proof' : 'the validators\' record, not yet proved';
    lines.push(cont(`${`${dest} tx`.padEnd(15)} ${r.ids.destination_tx}   (${from})`));
    if (r.links.destination_tx) lines.push(cont(`${' '.repeat(15)} ${r.links.destination_tx}`));
  }
  if (r.ids.proof_id) lines.push(cont(`proof           ${r.ids.proof_id}`));
  if (r.ids.write_back_tx) lines.push(cont(`write-back tx   ${r.ids.write_back_tx}`));

  if (r.request?.kind === 'transfer') {
    lines.push(rowOf('Sent', `${r.request.amount} ${r.request.asset ?? ''} on ${r.request.chain}: ${r.request.from ?? 'the abstract account'} -> ${r.request.to}`.replace(/\s+/g, ' ')));
  } else if (r.request?.kind === 'contract_call' && r.request.contract_call) {
    lines.push(rowOf('Called', `${r.request.contract_call.function_signature} on ${r.request.contract_call.target} (${r.request.chain})`));
  }

  lines.push(rowOf('Effect', r.effect.detail));
  lines.push(rowOf('Proof', proofLine(r)));
  // The overall reading is its own line only when it says something the proof line does not: the intent failed or has not finished, or the
  // proof verifies and something else (the recipient's balance) did not agree.
  if (r.verdict === 'failed' || r.verdict === 'pending' || r.verdict === 'unproven' || (r.verdict === 'partial' && r.proof.verdict === 'verified')) {
    lines.push(rowOf('Result', r.headline));
  }
  if (opts.savedTo) lines.push(rowOf('Saved', opts.savedTo));

  if (r.gaps.length > 0) {
    lines.push('');
    lines.push('  Not established:');
    for (const g of r.gaps) lines.push(`    - ${g.text}`);
  }

  if (opts.explain) {
    lines.push('');
    lines.push('  The proof, layer by layer (checked here, from the proof\'s own bytes; the bundle\'s own "verified" is never used):');
    if (r.proof.layers.length === 0) lines.push(`    ${r.proof.detail}`);
    const width = Math.max(4, ...r.proof.layers.map((l) => l.id.length));
    const LAYER: Record<string, string> = { verified: 'verified    ', failed: 'FAILED      ', not_checked: 'NOT CHECKED ', not_in_document: 'not carried ' };
    for (const l of r.proof.layers) {
      lines.push(`    ${l.id.padEnd(width)}  ${LAYER[l.verdict]}${l.title}${l.statement ? `  (${l.statement})` : ''}`);
      if (l.verdict === 'verified' && l.evidence) {
        const ev = Object.entries(l.evidence).filter(([, x]) => x !== null && x !== undefined);
        if (ev.length > 0) lines.push(`    ${' '.repeat(width)}  ${' '.repeat(12)}${ev.map(([k, x]) => `${k} ${shorten(x)}`).join(' · ')}`);
      } else if (l.reason) {
        lines.push(`    ${' '.repeat(width)}  ${' '.repeat(12)}${l.reason}`);
      }
    }
    lines.push('');
    lines.push(`  Layers carried: ${r.proof.layers_total}, verified here: ${r.proof.layers_verified}, not carried by this document: ${r.proof.layers_not_carried}.`);
    lines.push(`  The execution layer was ${r.proof.node_checked ? 'compared with a header from the node you gave' : 'NOT compared with a node of yours: it rests on the validators\' statement of the block'}.`);
    lines.push('  A valid proof of the WRONG call is still a valid proof: compare the operation with your own record of what was agreed.');
  }

  const next = nextCommand(r);
  if (next) {
    lines.push('');
    lines.push(`  Next: ${next}`);
  }
  lines.push('');
  return lines;
}

function shorten(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 22 && /^(0x)?[0-9a-f]+$/i.test(s) ? `${s.slice(0, 12)}…${s.slice(-6)}` : s;
}

/** Print the receipt: ordinary output in table mode, stderr in `--json` mode (where stdout is the one envelope). */
export function renderReceipt(r: Receipt, opts: { savedTo?: string; explain?: boolean } = {}): void {
  for (const line of receiptLines(r, opts)) human(line);
}
