// The stand-ins of Go's steps_2a_test.go `fake` for the steps a package has not ported yet (15-24 for package 2a). They do not judge: each
// reports its parts verified and fills only the facts the real steps 2a read (the attestation stations' AUTH words, the pkc, the level
// binding). They read the world parameters (roles, link, attestation blob) from the set's world.json, as Go's fixture reads its spec.
// A package replaces a stand-in by registering the real step: `composedVerifier(world, { steps: ['15', '16'] })`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  StepRegistry, TagCaptured, abidec, bytes, fixedRulesNotJudged, header, must, newVerifier, ownedBy, reads, registerSteps2a, registrableSteps, slots, spec, verified,
  type Env, type PartResult, type StepFn, type StepId, type StepOutput, type Verifier, type Words,
} from '../../src/proof-v2/identity/index.js';
import { VECTORS } from './fixtures.js';

void abidec;
export interface World { link: string; roles: Record<string, string>; attestation: { blob: string[] }; settlement: { anchor_id: string } }
export const loadWorld = (set: string): World => JSON.parse(readFileSync(join(VECTORS, set, 'world.json'), 'utf8')) as World;

const addr = (s: string): Uint8Array => bytes.unhexN(s.toLowerCase(), 20);

/** The AUTH words of one attestation station, read the way Go's fixture reads them (every read is a proven walk; one failing read fails the station). */
function authWords(env: Env, w: World, root: Uint8Array, flip: boolean): Words {
  const A = addr(w.roles['anchor']!);
  const V = addr(w.roles['verifier']!);
  const G = addr(w.roles['groth16']!);
  const O = addr(w.roles['owner']!);
  const nodes = env.nodes!;
  const acct = new Map<string, reads.AccountState>();
  for (const a of [A, V, G, O]) acct.set(bytes.hex(a), reads.readAccount(root, nodes, a));
  const words: Words = {};
  const rd = (id: string, a: Uint8Array, s: Uint8Array): Uint8Array => {
    const x = reads.readSlot(acct.get(bytes.hex(a))!.storageRoot, nodes, s);
    if (id !== '') words[id] = x;
    return x;
  };
  const anchorId = bytes.unhexN(w.settlement.anchor_id, 32);
  const rec = slots.mappingSlotAt(slots.keyBytes32(anchorId), 1);
  for (let k = 0; k < 13; k++) rd('', A, slots.memberSlot(rec, k));
  const first: [string, Uint8Array][] = [
    ['', slots.slotIndex(0)], ['', slots.mappingSlotAt(slots.keyBytes32(anchorId), 2)], ['', slots.mappingSlotAt(slots.keyBytes32(anchorId), 3)],
    ['A05', slots.mappingSlotAt(slots.keyBytes32(env.facts.B1.pkc), 4)], ['A07', slots.slotIndex(5)], ['', slots.slotIndex(6)],
  ];
  for (const [id, s] of first) rd(id, A, s);
  const nw = bytes.bigOf(rd('A10', A, slots.slotIndex(13)));
  for (let i = 0n; i < nw; i++) {
    const v = rd(`A10:${i}`, A, slots.arrayElementSlot(13, i, 20).slot);
    const a20 = bytes.low20(v);
    const k = 'A09:' + bytes.lowerHex(a20);
    const base = slots.mappingSlotAt(slots.keyAddress(a20), 12);
    rd(k + ':0', A, base);
    rd(k + ':1', A, slots.memberSlot(base, 1));
    rd(k + ':3', A, slots.memberSlot(base, 3));
    words[k + ':key'] = bytes.keccak(reads.readBytes(acct.get(bytes.hex(A))!.storageRoot, nodes, slots.memberSlot(base, 2), 256n));
  }
  const second: [string, number][] = [['A11', 14], ['', 15], ['', 16], ['A14', 17], ['', 27], ['', 29]];
  for (const [id, n] of second) rd(id, A, slots.slotIndex(n));
  words['A18'] = bytes.padWord(bytes.low20(rd('', A, slots.slotIndex(30))));
  if (flip) rd('', A, slots.mappingSlotAt(slots.keyBytes32(env.ctx.batch.operationId), 18));
  for (let n = 0; n < 3; n++) rd('', V, slots.slotIndex(n));
  return words;
}

const failedRead = () => must('contract_identity_proof_invalid', '', { root: 'attest_pre', address: new Uint8Array(20), slot: new Uint8Array(32) });

export function standIn(id: StepId, w: World): StepFn {
  const sp = spec(id)!;
  return (env: Env): StepOutput => {
    const out: StepOutput = { parts: sp.parts.map(verified) };
    const att = env.container!.attest;
    const unread = (): StepOutput => ({
      readPlanIncomplete: 'test: attestation read failed',
      parts: sp.parts.map((p): PartResult => ({ part: p, status: 'refused', state: failedRead() })),
    });
    switch (id) {
      case '15':
        env.facts.B1.attestCaptured = att.tag === TagCaptured;
        break;
      case '16':
        if (att.tag === TagCaptured) {
          try {
            const hv = header(env, att.attest!.headerV);
            const hp = header(env, att.attest!.headerVParent);
            env.facts.B1.stateRootPre = hp.stateRoot;
            env.facts.B1.stateRootPost = hv.stateRoot;
          } catch { return unread(); }
        }
        if (w.link === 'hops') out.readPlanIncomplete = 'test: hop reads not made';
        break;
      case '17':
        if (att.tag === TagCaptured) {
          try {
            const hv = header(env, att.attest!.headerV);
            for (const root of [hv.transactionRoot, hv.receiptsRoot]) reads.readIndexedLeaf(root, env.nodes!, BigInt(att.attest!.txIndex), env.limits.maxNodeBytes);
          } catch { return unread(); }
          env.facts.B1.pkc = bytes.unhexN(w.attestation.blob[13]!, 32);
        }
        break;
      case '18':
        if (att.tag === TagCaptured) {
          try {
            const pre = authWords(env, w, env.facts.B1.stateRootPre, true);
            const post = authWords(env, w, env.facts.B1.stateRootPost, true);
            env.facts.B2.pre.words = pre;
            env.facts.B2.post.words = post;
          } catch { return unread(); }
        }
        break;
      case '21':
        env.facts.C.registryLink = 'via S9';
        break;
      case '23':
        env.facts.C.rulesNotJudged = fixedRulesNotJudged();
        break;
      case '24':
        env.facts.C.level = { authenticated: true, judgedAtLevel: 'finalized', s7FinalizedStatus: '' };
        break;
      default:
    }
    return out;
  };
}

/** The composed verifier: the real steps of package 2a, plus those of `real.steps`; the stand-ins for every other registrable step. */
export function composedVerifier(w: World, real: { steps?: StepId[] } = {}): Verifier {
  const reg = new StepRegistry<StepFn>();
  registerSteps2a(reg);
  const ported = new Set<StepId>([...ownedBy('2a'), ...(real.steps ?? [])]);
  for (const id of registrableSteps()) if (!ported.has(id)) reg.register(id, standIn(id, w));
  return newVerifier(reg);
}
