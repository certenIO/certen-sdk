/**
 * Writes a directory of hostile inputs for the Go/TS cross-check of base-sepolia/finalized/v1 and the TypeScript verdict of each:
 *   <dir>/pins/*.json            pins variants (every variant of test/finality/basefinal/pinsvariants.ts, finality-delay edge values)
 *   <dir>/judge/*.json           judge-level worlds in the format of finality_base_final1/judge (seeded corruption, dropped nodes, legs, spines, pins variants)
 *   <dir>/cases/*.json + evidence/*.bin + legs/leg.json   hostile live containers (truncations, count bombs, header enums, flips past the LC)
 *   <dir>/ts_results.tsv         "<kind>/<name>\t<canonical verdict>" of the TypeScript verifier
 * The Go side (a throwaway test in the validator ref worktree) writes go_results.tsv with the same lines; the two files must be identical.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { defaultLimits } from '../../src/proof-v2/finality/codec.js';
import { ethl1PinsFrom } from '../../src/proof-v2/finality/ethl1/index.js';
import { parsePinsOverride, sepoliaPins } from '../../src/proof-v2/finality/pins.js';
import { BaseFinalKind } from '../../src/proof-v2/finality/basefinal/index.js';
import { SET_DIR, canonicalOutcome, judgeNames, legRef, loadJudge, read, runJudge, type JudgeCase, type LegFile } from '../../test/finality/basefinal/vectorset.js';
import { offsets } from '../../test/finality/basefinal/evlayout.js';
import { cloneWorld, okWorlds, prng, worldOf } from '../../test/finality/basefinal/world.js';
import { pinsText, variantDoc, variants } from '../../test/finality/basefinal/pinsvariants.js';

const OUT = process.env.XCHECK_DIR ?? '';
const hx = (b: Uint8Array): string => `0x${Buffer.from(b).toString('hex')}`;

it('writes the cross-check inputs and the TypeScript results', () => {
  expect(OUT, 'XCHECK_DIR').not.toBe('');
  for (const d of ['pins', 'judge', 'cases', 'evidence', 'legs']) mkdirSync(join(OUT, d), { recursive: true });
  const rows: string[] = [];
  copyFileSync(join(SET_DIR, 'pins', 'main.json'), join(OUT, 'pins', 'main.json'));
  copyFileSync(join(SET_DIR, 'legs', 'leg_47604755.json'), join(OUT, 'legs', 'leg.json'));

  const judgeFile = (name: string, c: JudgeCase, pins: string): void => {
    const j = { ...c, pins, expect: {} };
    writeFileSync(join(OUT, 'judge', `${name}.json`), JSON.stringify(j));
  };
  const runJudgeFile = (name: string, c: JudgeCase, pinsName: string): void => {
    const pinsBytes = Buffer.from(pinsName === 'pins/main.json' ? read('pins/main.json') : readFileSync(join(OUT, pinsName)));
    judgeFile(name, c, pinsName);
    rows.push(`judge/${name}\t${runJudge(c, parsePinsOverride(pinsBytes))}`);
  };

  const ROOT = loadJudge('synth_ok_root_claim_anchor');
  // 1. pins variants over the root-claim world
  for (const v of variants) {
    writeFileSync(join(OUT, 'pins', `pv_${v.name}.json`), pinsText(variantDoc(v)));
    runJudgeFile(`pv_${v.name}`, ROOT, `pins/pv_${v.name}.json`);
  }
  // 2. finality-delay edge values
  const resolved = BigInt((ROOT.expect.fields as Record<string, string>).resolved_at!);
  const T = BigInt(ROOT.a.timestamp);
  const delays = ['0', '1', String(T - resolved - 1n), String(T - resolved), String(T - resolved + 1n), '9223372036854775807', '9223372036854775808', '18446744073709551614', '18446744073709551615'];
  const text = read('pins/main.json').toString('utf8');
  delays.forEach((d, i) => {
    writeFileSync(join(OUT, 'pins', `dl_${i}.json`), text.replace('"finality_delay_seconds": 0', `"finality_delay_seconds": ${d}`));
    runJudgeFile(`dl_${i}`, ROOT, `pins/dl_${i}.json`);
  });
  // 3. seeded corruption and dropped nodes of every accepting world
  const rnd = prng(0xd1ce);
  for (const id of okWorlds()) {
    const base = loadJudge(id);
    const w = worldOf(id);
    const asCase = (c: ReturnType<typeof cloneWorld>): JudgeCase => ({
      ...base,
      a: { number: String(c.a.number), hash: hx(c.a.hash), state_root: hx(c.a.stateRoot), timestamp: String(c.a.timestamp) },
      leg: { chain: String(c.leg.chain), number: String(c.leg.number), hash: hx(c.leg.hash), header: hx(c.leg.headerRlp ?? new Uint8Array(0)) },
      game_proxy: hx(c.body.gameProxy),
      game_code: hx(c.body.gameCode),
      output_root_index: String(c.body.outputRootIndex),
      l2_spine: c.body.l2Spine.map(hx),
      nodes: c.body.nodes.map(hx),
    });
    for (let i = 0; i < 60; i++) {
      const c = cloneWorld(w);
      const part = Math.floor(rnd() * 5);
      const flip = (b: Uint8Array): void => {
        if (b.length > 0) b[Math.floor(rnd() * b.length)]! ^= 1 << Math.floor(rnd() * 8);
      };
      if (part === 0) flip(c.body.nodes[Math.floor(rnd() * c.body.nodes.length)]!);
      else if (part === 1) flip(c.body.gameCode);
      else if (part === 2) flip(c.body.l2Spine[Math.floor(rnd() * c.body.l2Spine.length)]!);
      else if (part === 3) flip(c.body.gameProxy);
      else flip(c.a.stateRoot);
      runJudgeFile(`fz_${id}_${i}`, asCase(c), 'pins/main.json');
    }
    for (let i = 0; i < w.body.nodes.length; i += 1) {
      const c = cloneWorld(w);
      c.body.nodes.splice(i, 1);
      runJudgeFile(`dr_${id}_${i}`, asCase(c), 'pins/main.json');
    }
    for (const [vn, f] of [
      ['k_max', (c: ReturnType<typeof cloneWorld>) => (c.body.outputRootIndex = 0xffffffff)],
      ['k_n', (c: ReturnType<typeof cloneWorld>) => (c.body.outputRootIndex = 20)],
      ['leg_num', (c: ReturnType<typeof cloneWorld>) => (c.leg.number += 1n)],
      ['leg_nohdr', (c: ReturnType<typeof cloneWorld>) => (c.leg.headerRlp = new Uint8Array(0))],
      ['spine_cut', (c: ReturnType<typeof cloneWorld>) => (c.body.l2Spine = c.body.l2Spine.slice(0, -1))],
      ['spine_dup', (c: ReturnType<typeof cloneWorld>) => (c.body.l2Spine = [...c.body.l2Spine, c.body.l2Spine[c.body.l2Spine.length - 1]!])],
      ['spine_rev', (c: ReturnType<typeof cloneWorld>) => (c.body.l2Spine = [...c.body.l2Spine].reverse())],
      ['spine_junk', (c: ReturnType<typeof cloneWorld>) => (c.body.l2Spine = [c.body.l2Spine[0]!, Uint8Array.of(0xc0), ...c.body.l2Spine.slice(2)])],
      ['spine_empty_hdr', (c: ReturnType<typeof cloneWorld>) => (c.body.l2Spine = [new Uint8Array(0)])],
      ['ts_zero', (c: ReturnType<typeof cloneWorld>) => (c.a.timestamp = 0n)],
      ['ts_max', (c: ReturnType<typeof cloneWorld>) => (c.a.timestamp = 18446744073709551615n)],
    ] as const) {
      const c = cloneWorld(w);
      f(c);
      runJudgeFile(`va_${id}_${vn}`, asCase(c), 'pins/main.json');
    }
  }
  // 4. hostile live containers
  const lim = defaultLimits();
  const ep = ethl1PinsFrom(sepoliaPins(parsePinsOverride(read('pins/main.json'))));
  const EV = Uint8Array.from(read('evidence/valid_leg_47604755.bin'));
  const O = offsets(EV, ep, lim);
  const kind = new BaseFinalKind();
  const mainPins = parsePinsOverride(read('pins/main.json'));
  const leg = legRef(JSON.parse(read('legs/leg_47604755.json').toString('utf8')) as LegFile);
  const liveCase = (name: string, ev: Uint8Array): void => {
    writeFileSync(join(OUT, 'evidence', `${name}.bin`), ev);
    writeFileSync(
      join(OUT, 'cases', `${name}.json`),
      JSON.stringify({ format: 'certen-finality-vectors/1', id: name, description: name, pins: 'pins/main.json', leg: 'legs/leg.json', evidence: `evidence/${name}.bin`, expect: {} }),
    );
    rows.push(`cases/${name}\t${canonicalOutcome(() => kind.verify(mainPins, leg, ev))}`);
  };
  const setU32 = (off: number, v: number): Uint8Array => {
    const out = Uint8Array.from(EV);
    new DataView(out.buffer).setUint32(off, v, false);
    return out;
  };
  const cuts = new Set<number>();
  for (let i = 0; i <= 120; i++) cuts.add(i);
  for (let i = 120; i < EV.length; i += 997) cuts.add(i);
  for (const b of [O.hdr, O.linksCount, O.lcEnd, O.l1Count, O.stateBlock, O.gameProxy, O.codeLen, O.outIdx, O.l2Count, O.nodesCount]) for (let d = -2; d <= 2; d++) cuts.add(b + d);
  for (const c of [...cuts].filter((x) => x >= 0 && x < EV.length).sort((a, b) => a - b)) liveCase(`cut_${c}`, EV.subarray(0, c));
  for (const [n, off] of [['links', O.linksCount], ['l1', O.l1Count], ['code', O.codeLen], ['l2', O.l2Count], ['nodes', O.nodesCount]] as const) {
    liveCase(`bomb_${n}`, setU32(off, 0xffffffff));
    liveCase(`one_${n}`, setU32(off, 1));
    liveCase(`zero_${n}`, setU32(off, 0));
  }
  liveCase('l2_1024_cut', setU32(O.l2Count, 1024).subarray(0, O.l2Count + 40));
  liveCase('l2_1025', setU32(O.l2Count, 1025));
  liveCase('code_262144', setU32(O.codeLen, 262144));
  liveCase('code_262145', setU32(O.codeLen, 262145));
  for (const lvl of [0, 1, 2, 4, 255]) {
    const e = Uint8Array.from(EV);
    e[O.level] = lvl;
    liveCase(`level_${lvl}`, e);
  }
  const trail = new Uint8Array(EV.length + 1);
  trail.set(EV);
  liveCase('trailing', trail);
  liveCase('unchanged', EV);
  // flips past the light-client part (the LC verifies; the spine, the state proofs and the game decide)
  const rnd2 = prng(0x7e57);
  for (let i = 0; i < 14; i++) {
    const e = Uint8Array.from(EV);
    const at = O.lcEnd + Math.floor(rnd2() * (EV.length - O.lcEnd));
    e[at]! ^= 1 << Math.floor(rnd2() * 8);
    liveCase(`flip_${at}`, e);
  }
  // the live container under pins variants (the pins file decides the bounds, the row used and the layout)
  const withPins = (name: string, pinsName: string): void => {
    const pb = Buffer.from(readFileSync(join(OUT, pinsName)));
    writeFileSync(
      join(OUT, 'cases', `${name}.json`),
      JSON.stringify({ format: 'certen-finality-vectors/1', id: name, description: name, pins: pinsName, leg: 'legs/leg.json', evidence: 'evidence/unchanged.bin', expect: {} }),
    );
    rows.push(`cases/${name}	${canonicalOutcome(() => kind.verify(parsePinsOverride(pb), leg, EV))}`);
  };
  const one = variantDoc({ name: 'x', mutate: (b) => (b.max_l2_headers = 1), expect: 'ok' });
  writeFileSync(join(OUT, 'pins', 'pv_max_l2_headers_one.json'), pinsText(one));
  for (const n of ['max_l2_headers_one', 'max_l2_headers_huge', 'impl_n_wraps_int64', 'impl_delay_u64_max', 'layout_args_per_root_64', 'layout_clone_tail_empty', 'impl_game_type_null', 'impl_interval_short_pair', 'impl_interval_null_pair', 'section_absent', 'portal_uppercase']) {
    withPins(`lv_${n}`, `pins/pv_${n}.json`);
  }
  rows.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  writeFileSync(join(OUT, 'ts_results.tsv'), `${rows.join('\n')}\n`);
  void judgeNames;
});
