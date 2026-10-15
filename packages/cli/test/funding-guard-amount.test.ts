import { describe, it, expect } from 'vitest';
import type { CertenClient } from '@certen.io/sdk';
import { assertFundedForValue } from '../src/funding-guard.js';

/**
 * The CLI funding guard, now that it compares the balance with what is being moved and not only with zero.
 *
 * The guard exists because an intent that moves value from an account that cannot pay for it is accepted, signed and submitted, and then
 * parks at `anchoring` forever, with nothing in any response saying why. It used to refuse only a balance it had seen to be zero. What is
 * pinned here is where the refusal now starts, and what it is careful NOT to refuse:
 *
 * - the AMOUNT half is a fact (the account holds less than it is about to send); the GAS half is an estimate, and says so;
 * - `call --value` is wei and a transfer's `amount` is whole units, and the same balance must be compared with each in its own unit;
 * - a token transfer does not draw down the gas balance, so its amount is not counted against it;
 * - a balance it cannot read, or an account with no balance reported yet, still never blocks;
 * - `--force` still gets past all of it.
 */

const ABS = '0xAbs';
function clientWith(chainId: string, balances: Array<{ token?: string; balance: string }>): CertenClient {
  return {
    portfolio: { get: async () => ({ identities: [{ chains: [{ chain_id: chainId, address: ABS, deployed: true, balances }] }] }) },
  } as unknown as CertenClient;
}

async function refusal(p: Promise<void>): Promise<{ code: string; message: string } | null> {
  try { await p; return null; } catch (e) { return e as { code: string; message: string }; }
}

const guard = (balance: string, intent: Record<string, unknown>, chain = 'base-sepolia', force = false, reserve?: string | null) =>
  refusal(assertFundedForValue(clientWith(chain, [{ token: 'ETH', balance }]), 'id', chain, intent, force, undefined, reserve));

describe('the CLI funding guard compares the balance with the amount', () => {
  it('refuses an account that holds less than it is about to send, as a fact, and names the faucet and --force', async () => {
    const r = await guard('0.0004', { amount: '0.001' });
    expect(r?.code).toBe('ABSTRACT_ACCOUNT_UNDERFUNDED');
    expect(r?.message).toMatch(/holds 0\.0004 ETH, less than the 0\.001 ETH this intent moves/);
    expect(r?.message).toContain('https://www.alchemy.com/faucets/base-sepolia');
    expect(r?.message).toMatch(/--force/);
    expect(r?.message).not.toMatch(/estimate/);
  });

  it('refuses an account that covers the amount but not the amount plus the gas estimate, and says that part is an estimate', async () => {
    const r = await guard('0.001', { amount: '0.001' });
    expect(r?.code).toBe('ABSTRACT_ACCOUNT_UNDERFUNDED');
    expect(r?.message).toMatch(/holds 0\.001 ETH; moving 0\.001 ETH and paying for the execution needs about 0\.0011 ETH/);
    expect(r?.message).toMatch(/gas share, 0\.0001 ETH, is an estimate, not a quote/);
  });

  it('allows an account that covers both, exactly at the boundary and above it', async () => {
    expect(await guard('0.0011', { amount: '0.001' })).toBeNull();
    expect(await guard('5', { amount: '0.001' })).toBeNull();
  });

  it('still says "holds no gas" for a zero balance, with the code it always had', async () => {
    const r = await guard('0', { amount: '0.001' });
    expect(r?.code).toBe('ABSTRACT_ACCOUNT_UNFUNDED');
    expect(r?.message).toMatch(/holds no testnet gas/);
  });

  it('refuses to send the whole balance, with or without an estimate for the chain, because nothing would be left for gas', async () => {
    // Adiri's gas is TEL: an ETH row there is not its gas, which is the unverifiable path and not this one.
    expect((await guard('2.5', { amount: '2.5' }, 'telcoin-adiri'))?.code).toBe('ABSTRACT_ACCOUNT_FUNDING_UNVERIFIABLE');
    const tel = await refusal(assertFundedForValue(clientWith('telcoin-adiri', [{ token: 'TEL', balance: '2.5' }]), 'id', 'telcoin-adiri', { amount: '2.5' }, false));
    expect(tel?.code).toBe('ABSTRACT_ACCOUNT_UNDERFUNDED');
    expect(tel?.message).toMatch(/nothing would be left to pay for gas/);
  });

  it('checks a chain with no gas estimate on the amount alone', async () => {
    const tel = (balance: string, amount: string) =>
      refusal(assertFundedForValue(clientWith('telcoin-adiri', [{ token: 'TEL', balance }]), 'id', 'telcoin-adiri', { amount }, false));
    expect(await tel('5', '1')).toBeNull();
    expect((await tel('0.5', '1'))?.code).toBe('ABSTRACT_ACCOUNT_UNDERFUNDED');
  });
});

describe('the CLI funding guard knows which unit it was given', () => {
  it('treats `value` as base units (what `call --value` is) and `amount` as whole units', async () => {
    // 0.005 ETH in wei, against a 0.001 ETH balance: short. The same digits as a whole-unit amount would be 5e15 ETH.
    const wei = await guard('0.001', { value: '5000000000000000' });
    expect(wei?.code).toBe('ABSTRACT_ACCOUNT_UNDERFUNDED');
    expect(wei?.message).toMatch(/less than the 0\.005 ETH this intent moves/);
    // 0.0001 ETH in wei, against 0.01 ETH: plenty.
    expect(await guard('0.01', { value: '100000000000000' })).toBeNull();
  });

  it('does not treat a wei value as whole units: a value that is small in wei is not a huge amount', async () => {
    expect(await guard('0.002', { value: '1000000000000000' })).toBeNull(); // 0.001 ETH, balance 0.002 >= 0.0011
  });

  it('does not block a call that forwards no value', async () => {
    expect(await guard('0', { value: '0' })).toBeNull();
    expect(await guard('0', {})).toBeNull();
  });

  it('does not count a token transfer\'s amount against the native balance, only the gas', async () => {
    expect(await guard('0.01', { amount: '5000', tokenSymbol: 'USDC' })).toBeNull();
    // ...but the gas must still be there.
    expect((await guard('0.00005', { amount: '5000', tokenSymbol: 'USDC' }))?.code).toBe('ABSTRACT_ACCOUNT_UNDERFUNDED');
    // A token named as the native token is the native token.
    expect((await guard('0.0004', { amount: '0.001', tokenSymbol: 'ETH' }))?.code).toBe('ABSTRACT_ACCOUNT_UNDERFUNDED');
  });
});

describe('what the CLI funding guard still never blocks on', () => {
  it('lets an unreadable balance, an account with no balance reported yet, and an unknown account through the guard\'s own rule', async () => {
    // A balance the bridge could not read is reported by name as unverifiable (existing behaviour), not as short.
    const unreadable = await refusal(assertFundedForValue(clientWith('base-sepolia', [{ token: 'ETH', balance: 'unavailable' }]), 'id', 'base-sepolia', { amount: '1' }, false));
    expect(unreadable?.code).toBe('ABSTRACT_ACCOUNT_FUNDING_UNVERIFIABLE');
    // Nothing reported yet is not evidence of zero.
    expect(await refusal(assertFundedForValue(clientWith('base-sepolia', []), 'id', 'base-sepolia', { amount: '1' }, false))).toBeNull();
    // Not in the portfolio.
    expect(await refusal(assertFundedForValue(clientWith('other', []), 'id', 'base-sepolia', { amount: '1' }, false))).toBeNull();
    // The portfolio failing to load.
    const broken = { portfolio: { get: async () => { throw new Error('down'); } } } as unknown as CertenClient;
    expect(await refusal(assertFundedForValue(broken, 'id', 'base-sepolia', { amount: '1' }, false))).toBeNull();
  });

  it('is bypassed by --force, whatever the shortfall', async () => {
    expect(await guard('0.0001', { amount: '4000' }, 'base-sepolia', true)).toBeNull();
    expect(await guard('0', { amount: '1' }, 'base-sepolia', true)).toBeNull();
  });

  it('reads the balances the caller already holds instead of the portfolio, and judges them the same way', async () => {
    let reads = 0;
    const client = { portfolio: { get: async () => { reads += 1; return { identities: [] }; } } } as unknown as CertenClient;
    const known = [{ chain_id: 'base-sepolia', address: ABS, token: 'ETH', balance: '0.0004' }];
    const r = await refusal(assertFundedForValue(client, 'id', 'base-sepolia', { amount: '0.001' }, false, known));
    expect(r?.code).toBe('ABSTRACT_ACCOUNT_UNDERFUNDED');
    expect(reads).toBe(0);
  });
});

describe('the gas reserve can be replaced or removed', () => {
  it('takes a larger reserve as a reason to refuse, and null as "no estimate"', async () => {
    expect((await guard('0.002', { amount: '0.001' }, 'base-sepolia', false, '0.01'))?.code).toBe('ABSTRACT_ACCOUNT_UNDERFUNDED');
    expect(await guard('0.0011', { amount: '0.001' }, 'base-sepolia', false, null)).toBeNull();
    // With no estimate at all, the amount still has to leave something over.
    expect((await guard('0.001', { amount: '0.001' }, 'base-sepolia', false, null))?.message).toMatch(/nothing would be left to pay for gas/);
  });
});
