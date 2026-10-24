/**
 * The TypeScript judge of RB12-TS-OPSSYNC: one function that turns an input of the pins corpus into the verdict text the Go oracle writes for
 * the same input (a throwaway Go program in a detached worktree of origin/pv2/rb12-ops-a1 @4c6b8d26 judged the same inputs; the format of the text
 * is the contract between the two). Used by the committed supplement vectors (pins_opssync_vectors.test.ts) and by the throwaway differential
 * runner. A verdict is a canonical named state or a summary of what loaded; any exception that is not a named state is `UNNAMED|...`, which no
 * Go verdict equals.
 *
 * kinds: pins (ParsePinsOverride), ext (embedded.Extend(raw, embedded links)), arb / bp / bf / ad (the section loader of arbfinal, baseposted,
 * basefinal, adiri after ParsePinsOverride), adig (RecordDigests of a hand-built CFA1), advcc (VerifyCommitteeChain, one-by-one, of the same).
 */
import { loadArbFinalPins } from '../../src/proof-v2/finality/arbfinal/pins.js';
import { parsePins as parseAdiriPins, recordDigests, Codec } from '../../src/proof-v2/finality/adiri/record.js';
import { KeyBytes, type CFA1, type EpochRec } from '../../src/proof-v2/finality/adiri/cfa1.js';
import { verifyCommitteeChain } from '../../src/proof-v2/finality/adiri/chain.js';
import type { Params } from '../../src/proof-v2/finality/adiri/record.js';
import { parseBasePins as parseBaseFinalPins } from '../../src/proof-v2/finality/basefinal/pins.js';
import { parseBasePins as parseBasePostedPins } from '../../src/proof-v2/finality/baseposted/pins.js';
import { embeddedLedgerLinks, extendPins } from '../../src/proof-v2/finality/ledger.js';
import { embeddedPins, parsePinsOverride, pinsIdentity, type Pins } from '../../src/proof-v2/finality/pins.js';
import { FinalityStateError, hexLower } from '../../src/proof-v2/finality/state.js';

export interface JudgeIn {
  id: string;
  kind: string;
  /** the bytes of a pins file, hex or base64 */
  hex?: string;
  b64?: string;
  /** adig / advcc: the number of keys of each table, and the (committee, next) table indices of each record */
  tables?: number[];
  records?: [number, number][];
}

const unnamed = (e: unknown): string => `UNNAMED|${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
const named = (e: unknown): string => (e instanceof FinalityStateError ? e.canonical() : unnamed(e));
const hx = (b: Uint8Array): string => hexLower(b);

function tableOf(n: number, salt: number): Uint8Array[] {
  const t: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const k = new Uint8Array(KeyBytes);
    k[0] = salt;
    k[1] = i;
    t.push(k);
  }
  return t;
}

function chainFrom(inp: JudgeIn): CFA1 {
  const cf: CFA1 = { tables: (inp.tables ?? []).map((n, i) => tableOf(n, i)), records: [] };
  (inp.records ?? []).forEach(([c, n], i) => {
    const fs = new Uint8Array(32);
    fs[0] = i;
    fs[1] = 1;
    const fc = new Uint8Array(32);
    fc[0] = i;
    fc[1] = 2;
    const rec: EpochRec = {
      committeeIdx: c,
      nextIdx: n,
      finalState: { number: BigInt(100 + i), hash: fs },
      finalConsensus: { number: BigInt(200 + i), hash: fc },
      signature: new Uint8Array(48),
      signers: Uint8Array.of(0, 1, 2),
    };
    cf.records.push(rec);
  });
  return cf;
}

export function judge(inp: JudgeIn): string {
  if (inp.kind === 'adig' || inp.kind === 'advcc') {
    const cf = chainFrom(inp);
    try {
      if (inp.kind === 'adig') return `ok|${recordDigests(cf).map(hx).join(',')}`;
      const par: Params = {
        chainId: 2017n,
        codec: Codec,
        genesisHash: new Uint8Array(32),
        genesisCommittee: cf.tables[0]!,
        epoch0FinalState: cf.records.length > 0 ? cf.records[0]!.finalState : { number: 0n, hash: new Uint8Array(32) },
        genesisLinkSha: '',
        minCommittee: 4n,
        maxHeaders: 16n,
        eip2935Address: new Uint8Array(20),
        eip2935CodeHash: new Uint8Array(32),
      };
      verifyCommitteeChain(par, cf, 'oneByOne');
      return 'ok';
    } catch (e) {
      return e instanceof FinalityStateError ? `E|${e.canonical()}` : unnamed(e);
    }
  }
  const raw = Uint8Array.from(inp.b64 !== undefined ? Buffer.from(inp.b64, 'base64') : Buffer.from(inp.hex ?? '', 'hex'));
  if (inp.kind === 'ext') {
    try {
      const p = extendPins(embeddedPins(), raw, embeddedLedgerLinks());
      return `ok|${pinsIdentity(p)[1]}`;
    } catch (e) {
      return e instanceof FinalityStateError ? `E|${e.canonical()}` : unnamed(e);
    }
  }
  let p: Pins;
  try {
    p = parsePinsOverride(raw);
  } catch (e) {
    return `PIN|${named(e)}`;
  }
  if (inp.kind === 'pins') {
    const [h, src] = pinsIdentity(p);
    return `ok|${h}|${src}`;
  }
  try {
    switch (inp.kind) {
      case 'arb': {
        const a = loadArbFinalPins(p);
        const lp = [...a.logicPins.entries()].map(([k, v]) => `${k.slice(2)}=${v}`).sort();
        const s = a.sel;
        return `ok|rollup=${hx(a.rollup)}|bold=${a.boldGenesisL2Block}|mhc=${a.maxHeaderChain}|lp=${lp.join(',')}|sel=${[s.confirm, s.force, s.fast, s.fastNew, s.walletTx, s.walletTxs, s.walletTxRefund, s.walletTxsRef].map(hx).join(',')}|top=${hx(a.topic.confirmed)},${hx(a.topic.forceConfirmed)}`;
      }
      case 'bp': {
        const b = parseBasePostedPins(p);
        return `ok|chain=${b.chainId}|sys=${hx(b.systemConfig)}|inbox=${hx(b.batchInbox)}|seq=${b.seqWindowSize}|ct=${b.channelTimeout}|blobs=${b.maxBlobs}|hashes=${b.systemConfigImplHashes.size}|kzg=${b.kzgSetupSha256}|${b.kzgSetupKey}`;
      }
      case 'bf': {
        const b = parseBaseFinalPins(p);
        return `ok|chain=${b.chainId}|portal=${hx(b.portal)}|sys=${hx(b.systemConfig)}|maxl2=${b.maxL2Headers}|impl=${b.impl.size}|proxy=${b.proxy.size}|layouts=${b.layouts.size}`;
      }
      case 'ad': {
        const a = parseAdiriPins(p);
        return `ok|chain=${a.chainId}|codec=${a.codec}|gc=${a.genesisCommittee.length}|min=${a.minCommittee}|max=${a.maxHeaders}|gh=${hx(a.genesisHash)}|e0=${a.epoch0FinalState.number},${hx(a.epoch0FinalState.hash)}|link=${a.genesisLinkSha}|eip=${hx(a.eip2935Address)},${hx(a.eip2935CodeHash)}`;
      }
      default:
        return 'BADKIND';
    }
  } catch (e) {
    const tag = { arb: 'ARB', bp: 'BP', bf: 'BF', ad: 'AD' }[inp.kind] ?? 'BADKIND';
    return `${tag}|${named(e)}`;
  }
}
