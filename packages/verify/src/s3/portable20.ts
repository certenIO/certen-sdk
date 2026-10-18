/**
 * A portable document of evidence 2.0 as Go's Import reads it, written back in the spelling the 2.0 verifier (src/proof-v2) reads.
 *
 * Go decodes the whole document before it verifies any of it (portable.go Import): the genesis records, every major block, the receipts, the
 * minor-root runs, the anchor message, every page's account, every vote and anchor, the set check's accounts and records are each decoded by
 * the generated unmarshalers, and a document any of them refuses is refused whatever else it holds. The 2.0 verifier reads those members with the
 * SDK's JSON constructors, which are lenient and strict in other places than Go's, so it is handed the document those decoders made: every record
 * re-spelled as Accumulate's MarshalJSON writes it (exact keys, canonical names, lower-case hex), and the document refused first - with the
 * decoders the 2.1 verifier imports with - when Go would refuse it.
 */
import { equal, VerifyError } from '../proof-v2/bytes.js';
import type { Rec } from '../proof-v2/shapes.js';
import { importEvidence, type Evidence } from './evidence.js';
import { goHex, goHexError, str, struct, u64 } from './gojson.js';
import { nodeFromJson, recordBytes, unionFromJson } from './jsonwire.js';
import { canonReceipt, majorFromJson } from './minorroot.js';
import { decodeAccount } from './model.js';
import { nodeToJson } from './nodejson.js';
import type { CheckAccount } from './setcheck.js';

/** A record of the genesis or the set check, decoded by its generated unmarshaler, as MarshalJSON writes it. */
function recordJson(cls: string, raw: unknown, label: string): { json: Rec; bin: Uint8Array } {
  const bin = recordBytes(cls, raw, label);
  return { json: nodeToJson(nodeFromJson(cls, raw, label)) as Rec, bin };
}

function accountJson(raw: unknown, label: string): Rec {
  const node = unionFromJson('Account', raw, label);
  if (!node) throw new VerifyError(`${label}: an account of no type`);
  return nodeToJson(node, 'Account') as Rec;
}

/** A PortableAccount of the set check, imported and written back. */
function checkAccountJson(a: CheckAccount, recordCls: string, label: string): Rec {
  const sr = struct(a.json.stateReceipt, ['localBlock'], `${label} stateReceipt`);
  return {
    accountUrl: a.accountUrl,
    account: nodeToJson(a.node, 'Account'),
    record: recordJson(recordCls, a.json.record, `${label} record`).json,
    stateReceipt: { start: a.receipt.start, anchor: a.receipt.anchor, localBlock: u64(sr.localBlock, `${label} stateReceipt.localBlock`), entries: a.receipt.entries },
    chains: a.chains,
    secondaryHash: a.secondaryHash,
    pendingHash: a.pendingHash,
  };
}

/**
 * The refusal of the set check's accounts, when Go's Import would refuse them: the 2.0 verifier reports its stages in order (src/proof-v2/layers.ts
 * says which layer a document fails at), and the set check is the last of them, so this refusal is held and raised when that stage is reached.
 * The document is refused either way.
 */
export const SET_CHECK_REFUSAL: unique symbol = Symbol('setCheckRefusal');

/** Import (portable.go) of a document of evidence 2.0 and the document written back in the spelling of the 2.0 verifier. */
export function canonicalize20(doc: Rec): Rec & { [SET_CHECK_REFUSAL]?: Error } {
  // The genesis: each JSON decoded by its unmarshaler must write the record the incarnation commits to (sameEncoding).
  const g = struct(doc.genesis, ['network', 'globals', 'networkRecord', 'globalsRecord'], 'PortableGenesis');
  const genesis: Rec = { ...(doc.genesis as Rec) };
  for (const [what, cls, record] of [['network', 'NetworkDefinition', g.networkRecord], ['globals', 'NetworkGlobals', g.globalsRecord]] as const) {
    const hex = str(record, `genesis.${what}Record`);
    const bytes = goHex(hex);
    if (!bytes) throw new VerifyError(`genesis.${what}Record: ${goHexError(hex)}`);
    const raw = g[what];
    if (raw === undefined) throw new VerifyError(`genesis ${what}: unexpected end of JSON input`);
    let r: { json: Rec; bin: Uint8Array };
    try {
      r = recordJson(cls, raw, `genesis ${what}`);
    } catch (e) {
      throw new VerifyError(`genesis ${what}: ${(e as Error).message}`);
    }
    if (!equal(r.bin, bytes)) throw new VerifyError(`genesis ${what}: the JSON does not re-encode to the record`);
    genesis[what] = r.json;
  }
  const majors = ((doc.majors as unknown[] | null) ?? []).map((m, i) => majorFromJson(m, `major ${i + 1}`));

  // The evidence, imported as Go imports it: every member decoded, or the document refused.
  // only a refusal of the set check's accounts is held; any other member Go refuses is refused now
  const holder: { refusal?: Error } = {};
  const ev: Evidence = importEvidence(doc, holder);
  const held = holder.refusal;
  const e = doc.evidence as Rec;
  const pagesIn = (e.pages as Rec[] | null) ?? [];
  const out: Rec = {
    ...e,
    receipt: canonReceipt(ev.receipt),
    certify: ev.certify,
    anchor: { message: ev.anchor.message.canonical, receipt: canonReceipt(ev.anchor.receipt) },
    pages: ev.pages.map((p, i) => ({
      ...pagesIn[i],
      account: nodeToJson(decodeAccount(p.state), 'Account'),
      receipt: canonReceipt(p.receipt),
    })),
    check: held
      ? { ...(e.check as Rec), hops: ev.check.hops }
      : { ...(e.check as Rec), hops: ev.check.hops, network: checkAccountJson(ev.check.network, 'NetworkDefinition', 'set check network'), globals: checkAccountJson(ev.check.globals, 'NetworkGlobals', 'set check globals') },
  };
  const result: Rec & { [SET_CHECK_REFUSAL]?: Error } = { ...doc, genesis, majors, evidence: out };
  if (held) result[SET_CHECK_REFUSAL] = held;
  return result;
}
