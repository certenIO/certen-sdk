import { describe, it, expect, afterEach } from 'vitest';
import { startWorld, INTENT, GOOD_HEADER, WRONG_ROOT_HEADER, type AgentWorld } from './agent-world.js';

/**
 * `certen_proof_verify`'s `header`: a block header the agent fetched from its own node, which the tool compares with the proof.
 *
 * The tool used to hand whatever it was given straight to the verifier, and a header with nothing in it to disagree with the proof (`{}`, or only
 * the block number the bundle itself states) was "a comparison" that found no disagreement: the execution layer read VERIFIED having compared
 * nothing. An agent that sent a header it had half-filled in, or whose own tool returned a reply without the receipts root, was told the
 * execution outcome was independently checked. Unknown is not ok: a header is a comparison only if it carries the receipts root.
 *
 * This is the same header `certen_receipt` takes, checked by the same SDK function, so the two tools cannot disagree about what a header is.
 */

const worlds: AgentWorld[] = [];
afterEach(async () => { for (const w of worlds.splice(0)) await w.close(); });
const world = async (): Promise<AgentWorld> => { const w = await startWorld(); worlds.push(w); return w; };
const outcome = (body: any) => body.layers.find((l: { id: string }) => l.id === 'outcome');

describe('certen_proof_verify: the header', () => {
  it('without a header the execution layer is NOT checked (the validators\' statement is all there is)', async () => {
    const w = await world();
    const r = await w.call('certen_proof_verify', { target: INTENT });
    expect(r.isError, r.text).toBe(false);
    expect(outcome(r.body).verdict).toBe('not_checked');
    expect(r.body.headerCheck).toBeNull();
  });

  it('a full header from the agent\'s own node closes the execution layer', async () => {
    const w = await world();
    const r = await w.call('certen_proof_verify', { target: INTENT, header: GOOD_HEADER });
    expect(outcome(r.body).verdict).toBe('verified');
    expect(r.body.headerCheck).toMatchObject({ ok: true });
  });

  it('a header whose receipts root differs FAILS the layer', async () => {
    const w = await world();
    const r = await w.call('certen_proof_verify', { target: INTENT, header: WRONG_ROOT_HEADER });
    expect(outcome(r.body).verdict).toBe('failed');
    expect(r.body.overall).toBe('failed');
  });

  it.each([
    ['an empty header', {}],
    ['only the block number, which the bundle itself states', { number: GOOD_HEADER.number }],
    ['only the block hash', { hash: GOOD_HEADER.hash }],
    ['a receipts root that is not a hash', { receiptsRoot: 'latest' }],
    ['a block number that is not a number', { ...GOOD_HEADER, number: 'latest' }],
  ])('refuses %s with INVALID_HEADER instead of reading it as a comparison that passed', async (_name, header) => {
    const w = await world();
    const r = await w.call('certen_proof_verify', { target: INTENT, header });
    expect(r.isError, r.text).toBe(true);
    expect(r.body.error.code).toBe('INVALID_HEADER');
    // And it was refused before the proof was fetched: nothing was read to be misreported.
    expect(w.gateway.hits).toEqual([]);
  });
});
