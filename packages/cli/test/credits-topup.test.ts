import { describe, it, expect, afterEach } from 'vitest';
import { certen, envelope } from './helpers/run-cli.js';
import { startStub, homeFor, WHO, API_KEY, type Stub, type Seen, type Reply } from './helpers/stub-gateway.js';

/**
 * `certen credits topup --credits <n>`: credits for a key page, paid by the PLATFORM.
 *
 * It spends someone else's money, so what is pinned is what keeps that from happening by accident:
 *
 * - bad input (a count that is not a whole number of at least 1, a key the gateway would refuse) costs a message and NO request;
 * - nothing spends unattended: with nobody at a terminal it refuses before it reads or sends anything unless `--yes` was passed, and `--json`
 *   is not consent (the terminal case, with a person who says no, is in spend-confirm.test.ts);
 * - the Idempotency-Key it used is printed, human and JSON, and passing it back sends that same key;
 * - an operator who has not switched it on, or a limit, is explained and not retried: one request, never more;
 * - `unconfirmed` is not hidden and not a success: the credits MAY have been added, it exits 1, and the command that settles it is named;
 * - the API key appears nowhere in anything it prints.
 */

const ACCEPTED = {
  topup_id: 't-1', identity_id: WHO.id, key_page_url: WHO.keyPage, credits: 500, status: 'submitted', tx_id: 'acc://abc@probe.acme/tx',
  credits_before: 12, note: 'submitted',
};
const UNCONFIRMED = { ...ACCEPTED, status: 'unconfirmed', tx_id: null, credits_before: null, note: 'the bridge did not say whether it submitted' };
const err = (code: string, status: number, message = `${code} happened`): Reply => ({ status, body: { error: message, code } });

let stub: Stub | undefined;
afterEach(async () => { await stub?.close(); stub = undefined; });

const POST = `/v1/identity/${WHO.id}/credits`;
const posts = (s: Stub): Seen[] => s.calls().filter((r) => r.method === 'POST' && r.path === POST);

async function serve(reply: Reply | ((r: Seen) => Reply) = { status: 202, body: ACCEPTED }): Promise<Stub> {
  stub = await startStub((r) => (r.method === 'POST' && r.path === POST ? (typeof reply === 'function' ? reply(r) : reply) : undefined));
  return stub;
}
const everything = (r: { stdout: string; stderr: string }): string => `${r.stdout}\n${r.stderr}`;
const TOPUP = ['credits', 'topup', '--credits', '500', '--yes'];

describe('a top-up', () => {
  it('POSTs { credits } to the identity with a key, once, and says submitted-not-confirmed', async () => {
    const g = await serve();
    const r = await certen(TOPUP, { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(posts(g)).toHaveLength(1);
    expect(posts(g)[0]!.body).toEqual({ credits: 500 });
    expect(posts(g)[0]!.headers['x-api-key']).toBe(API_KEY);
    expect(String(posts(g)[0]!.headers['idempotency-key'])).toMatch(/^certen-[0-9a-f-]{36}$/);
    expect(r.stdout).toContain('Submitted: 500 credits for the key page of acc://probe.acme.');
    expect(r.stdout).toContain('credits before  12');
    expect(r.stdout).toContain('Submitted means accepted, not yet confirmed');
    expect(r.stdout).toContain(`certen identity readiness ${WHO.id}`);
    // The card says what is about to be spent, and by whom.
    expect(r.stderr).toContain('Add 500 credits to the key page of acc://probe.acme');
    expect(r.stderr).toContain('1 credit = $0.01, so $5.00 of credits; a count of credits, not ACME');
    expect(r.stderr).toContain('paid by  the platform\'s sponsor account. Your organization is not charged');
  });

  it('prints the key it used, in both modes, and it is the key that was sent', async () => {
    const g = await serve();
    const home = homeFor(g.url);
    const human = await certen(TOPUP, { home, apiUrl: g.url });
    const json = await certen(['--json', ...TOPUP], { home, apiUrl: g.url });
    const sentHuman = String(posts(g)[0]!.headers['idempotency-key']);
    const sentJson = String(posts(g)[1]!.headers['idempotency-key']);
    expect(human.stdout).toContain(`key             ${sentHuman}`);
    expect(human.stderr).toContain(`Idempotency-Key ${sentHuman}`);
    const data = envelope(json).data!;
    expect(data.idempotency_key).toBe(sentJson);
    expect(data).toMatchObject({ ...ACCEPTED, idempotency_key: sentJson });
    // A different call is a different draw, so a different generated key.
    expect(sentJson).not.toBe(sentHuman);
  }, 60_000);

  it('--idempotency-key sends exactly that key, and a retry with it sends the same key again', async () => {
    const g = await serve();
    const home = homeFor(g.url);
    for (let i = 0; i < 2; i += 1) {
      const r = await certen(['--json', ...TOPUP, '--idempotency-key', 'order-4411:a_b.c'], { home, apiUrl: g.url });
      expect(r.code, r.stderr).toBe(0);
      expect(envelope(r).data!.idempotency_key).toBe('order-4411:a_b.c');
    }
    expect(posts(g).map((p) => p.headers['idempotency-key'])).toEqual(['order-4411:a_b.c', 'order-4411:a_b.c']);
  }, 60_000);

  it('takes the identity from --identity, and from the context (said on stderr)', async () => {
    const g = await serve();
    const home = homeFor(g.url);
    const flagged = await certen([...TOPUP, '--identity', WHO.id], { home, apiUrl: g.url });
    expect(flagged.code, flagged.stderr).toBe(0);
    const ctx = await certen(TOPUP, { home, apiUrl: g.url });
    expect(ctx.stderr).toContain(`using identity ${WHO.adi}`);
    expect(posts(g)).toHaveLength(2);
  }, 60_000);

  it('never prints the API key', async () => {
    const g = await serve();
    const r = await certen(TOPUP, { home: homeFor(g.url), apiUrl: g.url });
    expect(everything(r)).not.toContain(API_KEY);
    const j = await certen(['--json', ...TOPUP], { home: homeFor(g.url), apiUrl: g.url });
    expect(everything(j)).not.toContain(API_KEY);
  }, 60_000);
});

describe('bad input costs a message and no request', () => {
  it.each([
    ['zero', '0'], ['negative', '-1'], ['fractional', '1.5'], ['text', 'abc'], ['exponent', '1e3'], ['padded', '500 '], ['empty', ''],
    ['a leading zero', '05'], ['a sign', '+5'], ['past what a JSON number holds exactly', '99999999999999999999'], ['a thousands separator', '1,000'],
  ])('--credits %s: exit 2, INVALID_CREDITS, nothing sent', async (_label, value) => {
    const g = await serve();
    const r = await certen(['--json', 'credits', 'topup', '--credits', value, '--yes'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(2);
    const e = envelope(r);
    expect(e.error).toMatchObject({ code: 'INVALID_CREDITS', retryable: false, next: 'certen credits topup --help' });
    expect(e.error!.message).toContain('COUNT of credits');
    expect(g.seen).toHaveLength(0);
  });

  it('--credits is required', async () => {
    const g = await serve();
    const r = await certen(['--json', 'credits', 'topup', '--yes'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code).toBe(2);
    expect(g.seen).toHaveLength(0);
  });

  it.each(['has space', 'semi;colon', 'slash/y', 'x'.repeat(256), ''])('an Idempotency-Key the gateway would refuse (%j): exit 2, nothing sent', async (key) => {
    const g = await serve();
    const r = await certen(['--json', ...TOPUP, '--idempotency-key', key], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(2);
    expect(envelope(r).error).toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' });
    expect(g.seen).toHaveLength(0);
  });

  it('a key of the longest length the gateway accepts is accepted', async () => {
    const g = await serve();
    const key = 'k'.repeat(255);
    const r = await certen(['--json', ...TOPUP, '--idempotency-key', key], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(posts(g)[0]!.headers['idempotency-key']).toBe(key);
  });
});

describe('it never spends unattended', () => {
  it('with nobody at a terminal and no --yes it refuses (exit 2) before it reads or sends anything', async () => {
    const g = await serve();
    const r = await certen(['credits', 'topup', '--credits', '500'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('CONFIRMATION_REQUIRED');
    expect(r.stderr).toContain('spends the platform\'s funds');
    expect(r.stderr).toContain('pass --yes');
    expect(g.seen).toHaveLength(0);
  });

  it('--json is not consent: the envelope caller must pass --yes too', async () => {
    const g = await serve();
    const r = await certen(['--json', 'credits', 'topup', '--credits', '500'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code).toBe(2);
    const e = envelope(r);
    expect(e.error).toMatchObject({ code: 'CONFIRMATION_REQUIRED', retryable: false });
    expect(e.error!.message).toContain('--yes');
    expect(g.seen).toHaveLength(0);
  });

  it('refuses before it resolves the identity, so nothing is read for a spend nobody will confirm', async () => {
    const g = await serve();
    const bare = homeFor(g.url, { identity: false });
    const r = await certen(['--json', 'credits', 'topup', '--credits', '500'], { home: bare, apiUrl: g.url });
    expect(envelope(r).error!.code).toBe('CONFIRMATION_REQUIRED');
  });
});

describe('an outcome nobody knows is not a success', () => {
  it('unconfirmed: exit 1, ok:false, the credits MAY have been added, the key and the next command are given', async () => {
    const g = await serve({ status: 202, body: UNCONFIRMED });
    const home = homeFor(g.url);
    const json = await certen(['--json', ...TOPUP], { home, apiUrl: g.url });
    expect(json.code).toBe(1);
    const e = envelope(json);
    expect(e.ok).toBe(false);
    expect(e.data).toBeUndefined();
    const key = String(posts(g)[0]!.headers['idempotency-key']);
    expect(e.error).toMatchObject({ code: 'CREDIT_TOPUP_UNCONFIRMED', retryable: false, next: `certen identity readiness ${WHO.id}` });
    expect(e.error!.details).toMatchObject({ idempotency_key: key, credits: 500, may_have_been_applied: true, result: UNCONFIRMED });
    expect(e.error!.message).toContain('UNCONFIRMED');
    expect(e.error!.message).toContain('MAY already be on the key page');
    expect(e.error!.message).toContain('Do not top up again with a new key');
    expect(e.error!.message).toContain(`--idempotency-key ${key}`);

    const human = await certen(TOPUP, { home, apiUrl: g.url });
    expect(human.code).toBe(1);
    // No success wording anywhere, on either channel.
    expect(human.stdout).not.toMatch(/Submitted|submitted/);
    expect(human.stderr).toContain('Error [CREDIT_TOPUP_UNCONFIRMED]');
    expect(human.stderr).toContain(`next: certen identity readiness ${WHO.id}`);
  }, 60_000);

  it('a status this CLI does not know is not "submitted" either', async () => {
    const g = await serve({ status: 202, body: { ...ACCEPTED, status: 'applied-probably' } });
    const r = await certen(['--json', ...TOPUP], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code).toBe(1);
    expect(envelope(r).error).toMatchObject({ code: 'CREDIT_TOPUP_UNCONFIRMED' });
  });

  it('a connection that drops after the request left is exit 3, says the credits MAY have been added, and hands over the key to repeat with', async () => {
    const g = await serve({ destroy: true });
    const r = await certen(['--json', ...TOPUP], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code).toBe(3);
    const key = String(posts(g)[0]!.headers['idempotency-key']);
    const e = envelope(r);
    expect(e.error).toMatchObject({ code: 'NETWORK_ERROR', retryable: true });
    expect(e.error!.details).toMatchObject({ idempotency_key: key });
    expect(e.error!.message).toContain('the credits may have been added');
    expect(e.error!.message).toContain('Repeating it with the same key can never draw twice');
    expect(e.error!.message).toContain(`--idempotency-key ${key}`);
    // One attempt: this CLI did not repeat it on its own.
    expect(posts(g)).toHaveLength(1);
  });

  it('a server error says the same, with the key, and is not repeated by the CLI', async () => {
    const g = await serve(err('BAD_GATEWAY', 502, 'upstream went away'));
    const r = await certen(['--json', ...TOPUP], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code).toBe(1);
    const e = envelope(r);
    expect(e.error).toMatchObject({ code: 'BAD_GATEWAY', retryable: true, status: 502 });
    expect(e.error!.message).toContain('upstream went away');
    expect(e.error!.message).toContain('the credits may have been added');
    expect(e.error!.details).toMatchObject({ idempotency_key: String(posts(g)[0]!.headers['idempotency-key']) });
    expect(posts(g)).toHaveLength(1);
  });

  it('a request still running under that key says to wait and repeat with the SAME key', async () => {
    const g = await serve(err('IDEMPOTENCY_KEY_IN_FLIGHT', 409));
    const r = await certen(['--json', ...TOPUP, '--idempotency-key', 'k1'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code).toBe(1);
    expect(envelope(r).error!.message).toContain('repeat with the SAME key (k1)');
    expect(posts(g)).toHaveLength(1);
  });
});

describe('a feature that is off or limited is explained and never retried', () => {
  it('CREDIT_TOPUP_DISABLED: plain words, nothing was added, not retryable, one request', async () => {
    const g = await serve(err('CREDIT_TOPUP_DISABLED', 503));
    const home = homeFor(g.url);
    const json = await certen(['--json', ...TOPUP], { home, apiUrl: g.url });
    expect(json.code).toBe(1);
    const e = envelope(json);
    expect(e.error).toMatchObject({ code: 'CREDIT_TOPUP_DISABLED', retryable: false, status: 503, next: 'certen identity readiness' });
    expect(e.error!.message).toContain('is not switched on at this gateway');
    expect(e.error!.message).toContain('retrying will not');
    expect(e.error!.message).toContain('Nothing was added or charged');
    expect(posts(g)).toHaveLength(1);

    const human = await certen(TOPUP, { home, apiUrl: g.url });
    expect(human.stderr).toContain('Error [CREDIT_TOPUP_DISABLED]');
    expect(human.stderr).toContain('next: certen identity readiness');
    expect(posts(g)).toHaveLength(2); // one request per run, none repeated within a run
  }, 60_000);

  it('CREDIT_TOPUP_LIMIT: says which limit, that retrying now will not help, and is sent once', async () => {
    const g = await serve(err('CREDIT_TOPUP_LIMIT', 429, 'daily limit: 200 credits remain for this identity'));
    const r = await certen(['--json', ...TOPUP], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code).toBe(1);
    const e = envelope(r);
    // `retryable` is the SDK's own judgement (after its window it is); what this CLI does is not to retry it on its own.
    expect(e.error).toMatchObject({ code: 'CREDIT_TOPUP_LIMIT', retryable: true, status: 429 });
    expect(e.error!.message).toContain('daily limit: 200 credits remain for this identity');
    expect(e.error!.message).toContain('Retrying now will not help');
    expect(e.error!.message).toContain('Nothing was added');
    expect(posts(g)).toHaveLength(1);
  });

  it('a refusal the gateway states as a 4xx is its own error, untouched', async () => {
    const g = await serve(err('IDENTITY_NOT_FOUND', 404, 'no such identity'));
    const r = await certen(['--json', ...TOPUP], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code).toBe(1);
    expect(envelope(r).error).toMatchObject({ code: 'IDENTITY_NOT_FOUND', status: 404, next: 'certen identity list' });
    expect(posts(g)).toHaveLength(1);
  });
});
