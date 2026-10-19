/**
 * The Go types of a portable proof (validator pkg/proof/v2 portable.go: Portable and everything it holds), as the schema jsonx.ts decodes with the
 * rules of json.Unmarshal. A member of type json.RawMessage is 'raw': Go keeps its bytes and decodes them later (protocol.UnmarshalAccountJSON,
 * merkle.Receipt, api.MinorRootRecord ...), which the readers of this directory do from the tree gotree.ts makes of it.
 */
import { CHAIN_ROOT, PAGE_HISTORY } from './consensus.js';
import type { FieldDef, Sch, StructDef } from './jsonx.js';

const f = (name: string, sch: Sch): FieldDef => ({ name, json: name.charAt(0).toLowerCase() + name.slice(1), sch });
const j = (name: string, json: string, sch: Sch): FieldDef => ({ name, json, sch });

const S = 'string' as const;
const U = 'u64' as const;
const RAW = 'raw' as const;

const INDEX_PROOF: StructDef = [f('Position', U), f('Entry', S), f('Receipt', RAW)];
const ARRIVAL: StructDef = [f('Before', { ptr: INDEX_PROOF }), f('At', { struct: INDEX_PROOF })];
const HOP: StructDef = [f('Page', S), f('Message', S), f('Signature', S), f('Block', U), f('Receipt', RAW), f('Arrival', { ptr: ARRIVAL })];
const PRODUCTION: StructDef = [f('Account', S), f('Chain', S), f('Message', S), f('Receipt', RAW), f('Arrival', { struct: ARRIVAL }), f('Sequenced', RAW)];
const TRANSPORT: StructDef = [f('Kind', S), f('Source', S), f('Destination', S), f('Number', U)];
const VOTE: StructDef = [
  f('Authority', S),
  f('Origin', S),
  f('Vote', S),
  f('Cause', S),
  f('Transport', { struct: TRANSPORT }),
  f('Message', S),
  f('Receipt', RAW),
  f('Hops', { list: { struct: HOP } }),
  f('Counted', { list: { struct: HOP } }),
  f('Produced', { ptr: PRODUCTION }),
];
const ANCHOR: StructDef = [f('Message', RAW), f('Receipt', RAW)];
const PAGE: StructDef = [
  j('URL', 'url', S),
  f('Account', RAW),
  f('Receipt', RAW),
  f('Chains', { list: { struct: CHAIN_ROOT } }),
  f('PendingHash', S),
  f('ChainError', S),
  f('Partition', S),
  f('Roles', { list: S }),
  f('History', { ptr: PAGE_HISTORY }),
];
const ACCOUNT: StructDef = [
  j('AccountURL', 'accountUrl', S),
  f('Account', RAW),
  f('Record', RAW),
  f('StateReceipt', RAW),
  f('Chains', { list: { struct: CHAIN_ROOT } }),
  f('SecondaryHash', S),
  f('PendingHash', S),
];
const CHECK: StructDef = [f('Majors', U), f('Hops', { list: RAW }), f('Incarnation', S), f('Network', { struct: ACCOUNT }), f('Globals', { struct: ACCOUNT }), f('Routing', { ptr: ACCOUNT })];
const EVIDENCE: StructDef = [
  f('Version', S),
  f('Account', S),
  j('TxHash', 'txHash', S),
  f('Receipt', RAW),
  f('Majors', U),
  f('Certify', { list: RAW }),
  f('Anchor', { struct: ANCHOR }),
  f('Pages', { list: { struct: PAGE } }),
  f('Anchors', { map: { struct: ANCHOR } }),
  f('Votes', { list: { struct: VOTE } }),
  f('Transaction', S),
  f('Links', RAW),
  f('GenesisLink', RAW),
  f('Check', { struct: CHECK }),
];
const GENESIS: StructDef = [
  f('MinorBlockIndex', U),
  f('RootChainAnchor', S),
  f('StateTreeAnchor', S),
  f('TimeUnix', U),
  f('NetworkRecord', S),
  f('GlobalsRecord', S),
  f('Network', RAW),
  f('Globals', RAW),
];
const GOVROOT_INPUTS: StructDef = [j('G0Hash', 'g0Hash', S), j('G1Hash', 'g1Hash', S), j('G2Hash', 'g2Hash', S), j('KeyPageURL', 'keyPageUrl', S), j('KeyBookURL', 'keyBookUrl', S), j('OperationID', 'operationId', S)];

/** Portable. */
export const PORTABLE: Sch = {
  struct: [f('Format', S), f('Pin', S), f('Genesis', { struct: GENESIS }), f('Majors', { list: RAW }), f('Evidence', { struct: EVIDENCE }), f('GovRootV3Inputs', { ptr: GOVROOT_INPUTS })],
};
