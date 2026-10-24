/**
 * RB12-TS-OPSSYNC items 2 and 9, arbfinal: the port of arbfinal/pins_det_rb12_test.go (RB12-OPS-A1, BETA finding B-ARB-1) with the same inputs
 * and the same expected states, and the decision of the final Go rule for the case-variant logic_pins keys.
 *
 * Go has two places that answer a case-variant pair of logic_pins keys, and so has this port:
 *  1. the framework walk (finality.walkKeys), which refuses ANY two keys of one non-struct object that differ only in letter case as
 *     finality_pins_corrupt{duplicate_key, key} (the file never loads, whatever roles the two spellings carry);
 *  2. arbfinal.LoadPins, reached with a Pins built in memory (a file that did not come through the walk), where two spellings of one hash that
 *     name different roles are pin_mismatch{logic_pins} and the same role is one entry.
 * The first is the rule for every file; the second is kept as the defensive guard behind it, and the tests below show both, and that the
 * guard cannot be reached from a file.
 */
import { describe, expect, it } from 'vitest';
import { parseGoJson, type JVal } from '../../../src/s3/jsonx.js';
import { loadArbFinalPins } from '../../../src/proof-v2/finality/arbfinal/pins.js';
import { RoleWalletLogic, RoleWalletProxy } from '../../../src/proof-v2/finality/arbfinal/states.js';
import { embeddedPins, embeddedPinsBytes, loadPins, parsePinsOverride, type Pins } from '../../../src/proof-v2/finality/pins.js';
import { FinalityStateError, PinsReason, cmpUtf8, hexLower, pinsCorrupt } from '../../../src/proof-v2/finality/state.js';
import { sha256 } from '@noble/hashes/sha2';

const walletProxyHash = '0x8736329b580cfc0c0c39ee6700515e0bc51652afb614640db9e34a5d784933e8';
const walletLogicHash = '0x41aae8a0f910daa7a04450a94f864df487c0226c75e1809298c297d7f9e2f33a';
const detRuns = 1000;
const upperHash = (h: string): string => `0x${h.slice(2).toUpperCase()}`;

const embedded = embeddedPins();
const embeddedDoc = (): any => JSON.parse(new TextDecoder().decode(embeddedPinsBytes()));
interface Edit {
  path: string[];
  /** undefined deletes the member */
  val: unknown;
}
/** The embedded arb_sepolia section with every edit applied, as a Pins built in memory (the framework walk is NOT applied, like Go's pinsEdits). */
function pinsEdits(...edits: Edit[]): Pins {
  const sec = embeddedDoc().arb_sepolia;
  for (const e of edits) {
    let cur = sec;
    for (const k of e.path.slice(0, -1)) cur = cur[k];
    const last = e.path[e.path.length - 1]!;
    if (e.val === undefined) delete cur[last];
    else cur[last] = e.val;
  }
  return { ...embedded, sections: new Map<string, JVal>([['arb_sepolia', parseGoJson(JSON.stringify(sec))]]) };
}
const answer = (p: Pins): string => {
  try {
    const a = loadArbFinalPins(p);
    return `ok ${hexLower(a.rollup)}`;
  } catch (e) {
    return e instanceof FinalityStateError ? e.canonical() : `UNNAMED ${String(e)}`;
  }
};
const mismatch = (field: string): string => `{"code":"pin_mismatch","fields":{"field":"${field}"}}`;
function mustAnswerAlways(name: string, p: Pins, want: string): void {
  for (let i = 0; i < detRuns; i++) {
    const got = answer(p);
    if (got !== want) throw new Error(`${name}, load ${i}: got ${got}, want ${want}`);
  }
}

describe('arbfinal pins: the loader judged in memory, as pins_det_rb12_test.go does', () => {
  it('two spellings of one code hash that name different roles are pin_mismatch{logic_pins} every time', () => {
    const want = mismatch('logic_pins');
    // the upper-case spelling of the proxy hash names the LOGIC role: if it won the proxy role would be gone, if the real one won the file
    // would load; both are wrong answers to this file
    mustAnswerAlways('proxy hash under both roles', pinsEdits({ path: ['logic_pins', upperHash(walletProxyHash)], val: RoleWalletLogic }), want);
    mustAnswerAlways('logic hash under both roles', pinsEdits({ path: ['logic_pins', upperHash(walletLogicHash)], val: RoleWalletProxy }), want);
    // a third spelling that agrees with one of two that conflict does not make the set consistent
    const mixed = `0x${walletProxyHash.slice(2, 34).toUpperCase()}${walletProxyHash.slice(34)}`;
    mustAnswerAlways(
      'three spellings, two roles',
      pinsEdits({ path: ['logic_pins', upperHash(walletProxyHash)], val: RoleWalletProxy }, { path: ['logic_pins', mixed], val: RoleWalletLogic }),
      want,
    );
  });

  it('the same role under two spellings of one hash is one entry: the file loads, and the table has one row for the hash', () => {
    const p = pinsEdits({ path: ['logic_pins', upperHash(walletProxyHash)], val: RoleWalletProxy });
    let rollup = '';
    for (let i = 0; i < detRuns; i++) {
      const a = loadArbFinalPins(p);
      if (rollup === '') rollup = hexLower(a.rollup);
      expect(a.logicPins.get(walletProxyHash), `load ${i}`).toBe(RoleWalletProxy);
      expect([...a.logicPins.values()].filter((r) => r === RoleWalletProxy).length, `load ${i}`).toBe(1);
    }
  });

  it('several bad selector pins: the refusal names the first one by NAME; each case removes the one the previous case named', () => {
    const order = ['confirm_assertion', 'fast_confirm_new_assertion', 'force_confirm_assertion', 'wallet_execute_transactions'];
    order.forEach((named, i) => {
      const edits: Edit[] = [];
      order.slice(i).forEach((name, j) => {
        // three different ways to be bad, in turn: short, zero and absent
        edits.push({ path: ['confirm_path', 'selectors', name], val: ['0x1234', '0x00000000', undefined][j % 3] });
      });
      mustAnswerAlways(`selectors from ${named}`, pinsEdits(...edits), mismatch(`confirm_path.selectors.${named}`));
    });
  });

  it('several bad topic pins are named in sorted order, and the selectors are judged before the topics', () => {
    const both = pinsEdits(
      { path: ['confirm_path', 'topics', 'assertion_force_confirmed'], val: '0x12' },
      { path: ['confirm_path', 'topics', 'assertion_confirmed'], val: undefined },
    );
    mustAnswerAlways('both topics bad', both, mismatch('confirm_path.topics.assertion_confirmed'));
    const withSelector = pinsEdits(
      { path: ['confirm_path', 'topics', 'assertion_force_confirmed'], val: '0x12' },
      { path: ['confirm_path', 'topics', 'assertion_confirmed'], val: undefined },
      { path: ['confirm_path', 'selectors', 'wallet_execute_transaction'], val: '0x00000000' },
    );
    mustAnswerAlways('bad selector and bad topics', withSelector, mismatch('confirm_path.selectors.wallet_execute_transaction'));
  });

  it('the embedded section is untouched by all of this: it loads, and the same every time', () => {
    const first = answer(embedded);
    expect(first).toMatch(/^ok /);
    mustAnswerAlways('embedded', embedded, first);
  });
});

describe('item 9: the final Go rule for a file (finality.walkKeys), and the guard behind it (arbfinal.LoadPins)', () => {
  /** The file text of the embedded pins with one extra logic_pins member, keys sorted at every depth as the framework requires. */
  const sortKeys = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sortKeys)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort(cmpUtf8)
              .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
          )
        : v;
  const fileWith = (key: string, role: string): Uint8Array => {
    const doc = embeddedDoc();
    doc.arb_sepolia.logic_pins[key] = role;
    return new TextEncoder().encode(`${JSON.stringify(sortKeys(doc), null, 2)}\n`);
  };
  const secondOf = (a: string, b: string): string => [a, b].sort(cmpUtf8)[1]!;

  it('a file with two spellings of one hash is finality_pins_corrupt{duplicate_key} naming the second spelling in document order, whatever the roles', () => {
    for (const [hash, role] of [
      [walletProxyHash, RoleWalletLogic], // conflicting roles: Go's old answer depended on its map order
      [walletProxyHash, RoleWalletProxy], // the same role: the old TS twin loaded it, Go now refuses it
      [walletLogicHash, 'foo'],
      [walletLogicHash, RoleWalletLogic],
    ] as [string, string][]) {
      const raw = fileWith(upperHash(hash), role);
      const want = pinsCorrupt(PinsReason.DuplicateKey, { key: secondOf(hash, upperHash(hash)) }).canonical();
      for (const load of [() => parsePinsOverride(raw), () => loadPins(raw, sha256(raw))]) {
        let got = 'loaded';
        try {
          load();
        } catch (e) {
          got = e instanceof FinalityStateError ? e.canonical() : `UNNAMED ${String(e)}`;
        }
        expect(got, `${hash.slice(0, 10)} as ${role}`).toBe(want);
      }
    }
  });

  it('an irrelevant role under the second spelling is refused too (Go cbb6373 answered finalized for it)', () => {
    const bridge = Object.entries(embeddedDoc().arb_sepolia.logic_pins).find(([, r]) => r === 'bridge_impl')![0];
    for (const role of ['foo', 'bar', 'bridge_impl', 'rollup_unused']) {
      const raw = fileWith(upperHash(bridge), role);
      expect(() => parsePinsOverride(raw), role).toThrowError(expect.objectContaining({ code: 'finality_pins_corrupt', fields: expect.objectContaining({ reason: PinsReason.DuplicateKey }) }));
    }
  });

  it('the guard in the loader is reachable only with a Pins that did not come from a file, and answers as Go\'s LoadPins does there', () => {
    // from a file the loader never sees the pair: the file is refused first
    const raw = fileWith(upperHash(walletProxyHash), RoleWalletLogic);
    expect(() => parsePinsOverride(raw)).toThrow(FinalityStateError);
    // a Pins built in memory carries the pair to the loader: different roles are pin_mismatch{logic_pins}, one role is one entry
    expect(answer(pinsEdits({ path: ['logic_pins', upperHash(walletProxyHash)], val: RoleWalletLogic }))).toBe(mismatch('logic_pins'));
    expect(answer(pinsEdits({ path: ['logic_pins', upperHash(walletProxyHash)], val: RoleWalletProxy }))).toMatch(/^ok /);
  });

  it('a file whose logic_pins differ from the embedded ones only in the case of ONE key (no pair) still loads: the rule is about pairs, not about upper-case digits', () => {
    const doc = embeddedDoc();
    const lp = doc.arb_sepolia.logic_pins;
    const role = lp[walletProxyHash];
    delete lp[walletProxyHash];
    lp[upperHash(walletProxyHash)] = role;
    const raw = new TextEncoder().encode(`${JSON.stringify(sortKeys(doc), null, 2)}\n`);
    const a = loadArbFinalPins(parsePinsOverride(raw));
    expect(a.logicPins.get(walletProxyHash)).toBe(RoleWalletProxy);
  });
});
