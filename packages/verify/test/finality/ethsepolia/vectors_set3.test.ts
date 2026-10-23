/** finality_eth_sepolia3: the 16 ledger cases (VerifyLedger and Extend, review V-C2-A1 D1/D2) and the 5 lcssz cases (D3), the Go-written verdicts byte for byte. */
import { describe, expect, it } from 'vitest';
import * as lcssz from '../../../src/proof-v2/finality/ethsepolia/lcssz.js';
import { ledgerCaseFiles, lcsszCaseFiles, lcsszShape, loadLcsszCase, loadLedgerCase, runLedgerCase } from './vectorset.js';

describe('finality_eth_sepolia3 ledger cases', () => {
  const files = ledgerCaseFiles();
  it('there are 16 ledger cases', () => {
    expect(files.length).toBe(16);
  });
  for (const f of files) {
    it(
      f,
      () => {
        const c = loadLedgerCase(f);
        expect(runLedgerCase(c)).toBe(c.expect_canonical);
      },
      300_000,
    );
  }
});

describe('finality_eth_sepolia3 lcssz cases', () => {
  const files = lcsszCaseFiles();
  it('there are 5 lcssz cases', () => {
    expect(files.length).toBe(5);
  });
  for (const f of files) {
    it(f, () => {
      const c = loadLcsszCase(f);
      const fu = lcsszShape(c);
      let err: unknown;
      let got: ReturnType<typeof lcssz.finalizedExec> | undefined;
      try {
        got = lcssz.finalizedExec(lcssz.Electra, fu);
      } catch (e) {
        err = e;
      }
      expect(err instanceof RangeError, 'a RangeError escaped').toBe(false);
      switch (c.expect) {
        case 'ok':
          expect(err).toBeUndefined();
          expect(got!.hasNumber).toBe(true);
          expect(got!.number).toBe(BigInt(c.exec_number!));
          expect('0x' + Buffer.from(got!.hash).toString('hex')).toBe(c.exec_hash);
          break;
        case 'finalized_header_too_short':
          expect(err).toBeInstanceOf(lcssz.FinalizedHeaderTooShortError);
          expect(() => lcssz.finalityUpdateSlots(lcssz.Electra, fu), 'the shape must be one finalityUpdateSlots accepts').not.toThrow();
          break;
        case 'invalid':
          expect(err).toBeInstanceOf(lcssz.LcsszError);
          expect(err).not.toBeInstanceOf(lcssz.FinalizedHeaderTooShortError);
          break;
      }
    });
  }
});
