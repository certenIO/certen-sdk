import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { judgeS6Replay } from '../src/index.js';
import type { S6Settlement, S6Verdict } from '../src/index.js';
import { verifyProof } from '../src/s6/mpt.js';

/**
 * The independent review V-R10C's probes (runbooks/2026-10-proof-v2-completion/verification/V-R10C.md): concrete inputs built
 * on s6replay1 vector 001 and judged by Go (certen-validator pkg/ethproof s6replay1.Judge, trie.VerifyProof, go-ethereum
 * v1.17.7) at pv2/rb10-b-replay-slot-proof c2f408f. The file is the reviewer's byte-identical output (pinned by sha256 below);
 * the TypeScript verdict must equal Go's on every probe: result, state, reason, beforeVerified and every established line.
 *
 * D1: a hash/address/bytes value whose JSON text holds an escape is refused s6_replay_unproven{wrong_type} (Go's hexutil
 * types read the raw token). D2: a type-3 settlement transaction in its network form (sidecar v0 and v1) decodes as
 * go-ethereum BlobTx.decode does. The evidence is judged from evidenceHex, the exact bytes Go judged (two probes carry
 * invalid UTF-8 or a BOM that a JSON string cannot hold).
 */
const PROBES_SHA256 = '96e5a2b786a5942796232bc068f02369a7a48bd5a4a417f62a9815098a7436c1';

type Judge = { name: string; settlement: S6Settlement; evidence: string; evidenceHex: string; go: S6Verdict };
type Mpt = { name: string; root: string; key: string; nodes: string[]; go: string };

const raw = readFileSync(new URL('./fixtures/vr10c/probes.json', import.meta.url));
const probes: { judges: Judge[]; mpt: Mpt[] } = JSON.parse(raw.toString('utf8'));
const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s.slice(2), 'hex'));

describe('V-R10C probes judged exactly as Go does', () => {
  it('the probe file is the reviewer output', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(PROBES_SHA256);
    expect(probes.judges.length).toBe(11);
    expect(probes.mpt.length).toBe(10);
  });

  for (const p of probes.judges) {
    it(`judge ${p.name}: Go ${p.go.result}/${p.go.state}/${p.go.reason}`, () => {
      const got = judgeS6Replay(p.settlement, unhex(p.evidenceHex));
      expect(got).toEqual(p.go);
    });
  }

  for (const m of probes.mpt) {
    it(`mpt ${m.name}: Go ${m.go}`, () => {
      let got: string;
      try {
        const v = verifyProof(unhex(m.root), unhex(m.key), m.nodes.map(unhex));
        got = v === undefined ? 'absent' : `value:0x${Buffer.from(v).toString('hex')}`;
      } catch {
        got = 'error';
      }
      expect(got).toBe(m.go);
    });
  }
});
