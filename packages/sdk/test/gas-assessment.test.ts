import { describe, it, expect } from 'vitest';
import {
  assessGas, nativeAmountOf, gasReserveFor, parseUnits, formatUnits, readNativeBalance, CHAIN_CATALOGUE,
  type NativeBalanceReading,
} from '../src/index.js';

/**
 * Is there enough gas for this?
 *
 * One function decides it for the SDK guard, the CLI guard and `client.readiness()`, so the place a refusal starts is the same everywhere.
 * What each case pins has a plausible wrong answer:
 *
 * - the gateway's native balance is a WHOLE-UNIT decimal ("0.0021"), and amounts typed by people are whole units too, so a comparison in
 *   floats or in the wrong unit lets a short account through or refuses a funded one;
 * - an unreadable balance is UNKNOWN, never zero and never funded: the submit-time guard must not block on it and a readiness card must
 *   not call it ready;
 * - a token transfer does not draw down the gas balance, so its amount is not counted against it;
 * - moving the entire balance leaves nothing to pay gas with, estimate or no estimate.
 */

const funded = (balance: string, symbol = 'ETH'): NativeBalanceReading => ({ state: 'funded', symbol, balance });

describe('parseUnits / formatUnits', () => {
  it('are exact where floats are not', () => {
    expect(parseUnits('0.1', 18)).toBe(100000000000000000n);
    expect(parseUnits('0.000000000000000001', 18)).toBe(1n);
    expect(parseUnits('123456789.123456789123456789', 18)).toBe(123456789123456789123456789n);
    expect(formatUnits(100000000000000000n, 18)).toBe('0.1');
    expect(formatUnits(123456789123456789123456789n, 18)).toBe('123456789.123456789123456789');
    expect(formatUnits(0n, 18)).toBe('0');
    expect(formatUnits(1500000000000000n, 18)).toBe('0.0015');
    expect(formatUnits(2n * 10n ** 18n, 18)).toBe('2');
  });

  it('say undefined, not a number, for what is not a plain decimal', () => {
    for (const bad of ['unavailable', '', '-1', '1e-7', '0x10', '1,5', ' ', '1.2.3', undefined, null]) {
      expect(parseUnits(bad as string, 18), String(bad)).toBeUndefined();
    }
    expect(parseUnits('0.0000000000000000001', 18)).toBeUndefined(); // 19 places on an 18-decimal token
  });
});

describe('assessGas', () => {
  it('is empty on a positive zero, carrying what would be needed', () => {
    const a = assessGas({ chain: 'base-sepolia', reading: { state: 'empty', symbol: 'ETH', balance: '0' }, amount: '0.0005' });
    expect(a).toMatchObject({ state: 'empty', symbol: 'ETH', amount: '0.0005', reserve: '0.0001', needed: '0.0006' });
  });

  it('is sufficient when the balance covers the amount plus the estimate, and says an estimate was used', () => {
    const a = assessGas({ chain: 'base-sepolia', reading: funded('0.0021'), amount: '0.001' });
    expect(a).toMatchObject({ state: 'sufficient', estimated: true, needed: '0.0011', reserve: '0.0001', balance: '0.0021' });
  });

  it('is short on GAS when it covers the amount but not the amount plus the estimate', () => {
    const a = assessGas({ chain: 'base-sepolia', reading: funded('0.001'), amount: '0.001' });
    expect(a).toMatchObject({ state: 'short', kind: 'gas', needed: '0.0011', shortfall: '0.0001' });
    const b = assessGas({ chain: 'base-sepolia', reading: funded('0.00105'), amount: '0.001' });
    expect(b).toMatchObject({ state: 'short', kind: 'gas', shortfall: '0.00005' });
  });

  it('is short on the AMOUNT when the balance cannot cover what is being moved', () => {
    const a = assessGas({ chain: 'base-sepolia', reading: funded('0.0004'), amount: '0.001' });
    expect(a).toMatchObject({ state: 'short', kind: 'amount', balance: '0.0004', amount: '0.001' });
  });

  it('is exact at the boundary: exactly amount + reserve is enough, one base unit less is not', () => {
    expect(assessGas({ chain: 'base-sepolia', reading: funded('0.0011'), amount: '0.001' }).state).toBe('sufficient');
    expect(assessGas({ chain: 'base-sepolia', reading: funded('0.001099999999999999'), amount: '0.001' }).state).toBe('short');
  });

  it('judges the reserve alone when no native amount moves (a token transfer, or only a readiness check)', () => {
    expect(assessGas({ chain: 'base-sepolia', reading: funded('0.00005') }).state).toBe('short');
    expect(assessGas({ chain: 'base-sepolia', reading: funded('0.0002') }).state).toBe('sufficient');
  });

  it('does not count a token amount against the native balance', () => {
    expect(nativeAmountOf('base-sepolia', { amount: '1000', tokenSymbol: 'USDC' })).toBeUndefined();
    expect(nativeAmountOf('base-sepolia', { amount: '0.5', tokenSymbol: 'eth' })).toBe('0.5');
    expect(nativeAmountOf('base-sepolia', { amount: '0.5' })).toBe('0.5');
  });

  it('converts a contract call\'s wei value to whole units, and refuses to guess at something that is not digits', () => {
    expect(nativeAmountOf('base-sepolia', { amount: '1000000000000000', amountUnit: 'base' })).toBe('0.001');
    expect(nativeAmountOf('base-sepolia', { amount: '1.5', amountUnit: 'base' })).toBeUndefined();
    expect(nativeAmountOf('base-sepolia', { amount: '0', amountUnit: 'base' })).toBe('0');
  });

  it('refuses to leave nothing for gas when the whole balance is being moved, even with no estimate for the chain', () => {
    const a = assessGas({ chain: 'telcoin-adiri', reading: funded('2', 'TEL'), amount: '2' });
    expect(a).toMatchObject({ state: 'short', kind: 'gas', reserve: '0' });
  });

  it('checks only the amount on a chain with no estimate, and says no estimate was used', () => {
    expect(gasReserveFor('telcoin-adiri')).toBeUndefined();
    const a = assessGas({ chain: 'telcoin-adiri', reading: funded('5', 'TEL'), amount: '1' });
    expect(a).toMatchObject({ state: 'sufficient', estimated: false, reserve: '0' });
  });

  it('takes a caller\'s reserve over the catalogue\'s, and null as "none"', () => {
    expect(assessGas({ chain: 'base-sepolia', reading: funded('0.001'), amount: '0.001', reserve: null }).state).toBe('short'); // all of it, none left
    expect(assessGas({ chain: 'base-sepolia', reading: funded('0.0015'), amount: '0.001', reserve: null }).state).toBe('sufficient');
    expect(assessGas({ chain: 'base-sepolia', reading: funded('0.0015'), amount: '0.001', reserve: '0.01' }).state).toBe('short');
  });

  it('is UNKNOWN, with the reading, for every balance it cannot do arithmetic on', () => {
    const readings: NativeBalanceReading[] = [
      { state: 'no-balances' },
      { state: 'unknown-native', chain: 'solana-devnet' },
      { state: 'native-not-reported', chain: 'base-sepolia', symbol: 'ETH', reported: ['USDC'] },
      { state: 'unreadable', symbol: 'ETH', balance: 'unavailable' },
    ];
    for (const reading of readings) {
      expect(assessGas({ chain: 'base-sepolia', reading, amount: '1' }), reading.state).toMatchObject({ state: 'unknown', reading });
    }
  });

  it('is UNKNOWN, not empty and not funded, for a balance that is not a plain decimal', () => {
    // readNativeBalance reads "1e-7" as a positive number; arithmetic on it is not safe, so it is reported as unreadable.
    const reading = readNativeBalance('base-sepolia', [{ token: 'ETH', balance: '1e-7' }]);
    expect(reading.state).toBe('funded');
    expect(assessGas({ chain: 'base-sepolia', reading, amount: '0.001' })).toMatchObject({ state: 'unknown', reading: { state: 'unreadable' } });
  });

  it('is UNKNOWN on a chain whose gas token the catalogue does not know', () => {
    expect(assessGas({ chain: 'mystery-net', reading: funded('1') })).toMatchObject({ state: 'unknown', reading: { state: 'unknown-native' } });
  });

  it('works through a numeric chain id as well as a slug', () => {
    expect(assessGas({ chain: 84532, reading: funded('0.00001'), amount: '0' }).state).toBe('short');
    expect(assessGas({ chain: '84532', reading: funded('0.001'), amount: '0' }).state).toBe('sufficient');
  });
});

describe('the gas reserve table', () => {
  it('is a plain decimal that parses in the chain\'s own decimals, for every chain that has one', () => {
    for (const c of CHAIN_CATALOGUE) {
      if (c.gasReserve === undefined) continue;
      expect(parseUnits(c.gasReserve, c.nativeDecimals), c.slug).toBeGreaterThan(0n);
    }
  });

  it('is absent for retired chains, which are never offered, and for a chain nobody has estimated', () => {
    for (const c of CHAIN_CATALOGUE.filter((x) => x.support === 'retired')) expect(c.gasReserve, c.slug).toBeUndefined();
    expect(gasReserveFor('telcoin-adiri')).toBeUndefined();
  });

  it('is found by slug or by numeric id', () => {
    expect(gasReserveFor('base-sepolia')).toBe(gasReserveFor(84532));
    expect(gasReserveFor('base-sepolia')).toBeDefined();
    expect(gasReserveFor('nowhere')).toBeUndefined();
  });
});
