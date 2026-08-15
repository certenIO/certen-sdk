import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * `certen proof`.
 *
 * The cases here are drawn from what the LIVE gateway actually does, not from what the OpenAPI
 * document implies. Three behaviours came from running against production and would not have
 * been guessed:
 *
 * 1. **Every completed intent carries `proof_id: ""`** — an empty string, not `undefined` and not
 *    a missing key. `proof_id` being falsy is the normal case, not an edge case.
 * 2. **`accum_tx_hash` is a full ACME URL**, `acc://<64hex>@name.acme/data`, not a bare hash.
 *    Passing it through unmodified 404s.
 * 3. **The proof-service and Accumulate fail independently.** With the proof-service returning
 *    502 — its state during this work — `/v1/proof/{id}`, `/bundle` and `/custody` all fail while
 *    `/v1/proof/tx/{hash}/receipt` keeps answering. Reporting "no proof" on a 502 tells someone
 *    their evidence does not exist when it does.
 *
 * Both `HOME` and `USERPROFILE` are set on every spawn: `os.homedir()` reads `USERPROFILE` on
 * Windows, so setting only `HOME` silently targets the developer's real `~/.certen`.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const run = promisify(execFile);

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
interface Stub { url: string; close: () => Promise<void> }

async function stubGateway(handler: Handler): Promise<Stub> {
  const server = http.createServer((req, res) => {
    try { handler(req, res); } catch { res.statusCode = 500; res.end('{}'); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

interface Run { stdout: string; stderr: string; code: number; home: string }

async function certen(args: string[], apiUrl: string): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), 'certen-proof-'));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    USERPROFILE: home,
    CERTEN_API_URL: apiUrl,
    CERTEN_API_KEY: 'ck_live_test',
  };
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env, encoding: 'utf8', cwd: home });
    return { stdout, stderr, code: 0, home };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1, home };
  }
}

function soleJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  return JSON.parse(trimmed) as Record<string, unknown>;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

/** A Cloudflare-style 502: plain text, no JSON error envelope. Exactly what production returns. */
function badGateway(res: http.ServerResponse): void {
  res.statusCode = 502;
  res.setHeader('content-type', 'text/plain');
  res.end('error code: 502');
}

const INTENT = '15894e9b-b974-46fe-a327-ef63484b02a0';
const PROOF = 'fff1b28c-d555-4630-b96f-4ea834b5d61d';
const HASH = 'b6d2f36e4b1ce07d413911898f52f640553366f459a0b4d5cb61a114f2680016';

/** Shaped exactly as the live gateway returns it, ACME URL and empty proof_id included. */
const COMPLETED_INTENT = {
  intent_id: INTENT,
  status: 'completed',
  proof_id: '',
  accum_tx_hash: `acc://${HASH}@campaign-714942.acme/data`,
};

const RECEIPT = {
  tx_hash: HASH,
  status: 'delivered',
  principal: 'acc://campaign-714942.acme/data',
  tx_type: 'writeData',
  anchored: true,
  chain_index: 19,
  block_time: '2026-08-12T09:48:55Z',
  found: true,
  receipt: {
    start: HASH,
    end: HASH,
    anchor: '51b1581e780f345624d6f0596ace31a35d09c28073119bd2300a0b5abba12604',
    entries: [{ hash: 'f5f85de0fe22bc157501670f433d450652345076f1a6b6acca73fd011dc1e810' }],
  },
};

/** The live condition: proof-service 502s, Accumulate receipt answers. */
function proofServiceDown(): Handler {
  return (req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (url === `/v1/transaction/${INTENT}`) return json(res, 200, COMPLETED_INTENT);
    if (url === `/v1/proof/tx/${HASH}/receipt`) return json(res, 200, RECEIPT);
    if (url.startsWith('/v1/proof')) return badGateway(res);
    if (url.startsWith('/v1/transaction/')) return json(res, 404, { error: { message: 'not found' } });
    return json(res, 404, {});
  };
}

describe('proof get resolves whichever id the user is holding', () => {
  it('falls back to the Accumulate receipt when proof_id is the empty string', async () => {
    const stub = await stubGateway(proofServiceDown());
    try {
      const r = await certen(['--json', 'proof', 'get', INTENT], stub.url);
      expect(r.code).toBe(0);
      const data = soleJson(r.stdout).data as { source: string; anchored: boolean; tx_hash: string };
      expect(data.source).toBe('accumulate-receipt');
      expect(data.anchored).toBe(true);
      // The hash was extracted from an ACME URL. Passing that URL through would have 404'd.
      expect(data.tx_hash).toBe(HASH);
    } finally {
      await stub.close();
    }
  });

  it('accepts a bare transaction hash', async () => {
    const stub = await stubGateway(proofServiceDown());
    try {
      const r = await certen(['--json', 'proof', 'get', HASH], stub.url);
      expect(r.code).toBe(0);
      expect((soleJson(r.stdout).data as { tx_hash: string }).tx_hash).toBe(HASH);
    } finally {
      await stub.close();
    }
  });

  it('accepts a 0x-prefixed hash', async () => {
    const stub = await stubGateway(proofServiceDown());
    try {
      const r = await certen(['--json', 'proof', 'get', `0x${HASH}`], stub.url);
      expect(r.code).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it('rejects something that is neither a UUID nor a hash, as a usage error', async () => {
    const stub = await stubGateway(proofServiceDown());
    try {
      const r = await certen(['--json', 'proof', 'get', 'not-an-id'], stub.url);
      expect(r.code).toBe(2);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('INVALID_PROOF_TARGET');
    } finally {
      await stub.close();
    }
  });

  it('prefers the proof-service when it IS available', async () => {
    const stub = await stubGateway((req, res) => {
      const url = (req.url ?? '').split('?')[0];
      if (url === `/v1/transaction/${INTENT}`) {
        return json(res, 200, { ...COMPLETED_INTENT, proof_id: PROOF });
      }
      if (url === `/v1/proof/${PROOF}`) return json(res, 200, { proof_id: PROOF, attestations: [] });
      return json(res, 404, {});
    });
    try {
      const r = await certen(['--json', 'proof', 'get', INTENT], stub.url);
      expect(r.code).toBe(0);
      expect((soleJson(r.stdout).data as { source: string }).source).toBe('proof-service');
    } finally {
      await stub.close();
    }
  });
});

describe('a 502 is never reported as "no proof"', () => {
  it('says the SERVICE is down, and that the proof is not missing', async () => {
    const stub = await stubGateway((req, res) => {
      // A bare proof id: not an intent, and the proof-service cannot answer.
      if ((req.url ?? '').startsWith(`/v1/transaction/${PROOF}`)) {
        return json(res, 404, { error: { message: 'not found' } });
      }
      return badGateway(res);
    });
    try {
      const r = await certen(['--json', 'proof', 'get', PROOF], stub.url);
      expect(r.code).toBe(1);
      const err = soleJson(r.stdout).error as { code: string; message: string; retryable: boolean };
      expect(err.code).toBe('PROOF_SERVICE_UNAVAILABLE');
      // The distinction that matters: "unavailable" is not "absent".
      expect(err.message).toMatch(/does NOT mean the proof is missing/);
      // The service will come back; the caller should try again rather than conclude anything.
      expect(err.retryable).toBe(true);
    } finally {
      await stub.close();
    }
  });

  it('bundle explains that the packaging service is down, not the proof', async () => {
    const stub = await stubGateway(() => undefined as never).catch(() => null);
    const down = await stubGateway((_req, res) => badGateway(res));
    try {
      const r = await certen(['--json', 'proof', 'bundle', PROOF], down.url);
      expect(r.code).toBe(1);
      const err = soleJson(r.stdout).error as { code: string; message: string };
      expect(err.code).toBe('PROOF_SERVICE_UNAVAILABLE');
      expect(err.message).toMatch(/not lost/);
    } finally {
      await down.close();
      await stub?.close();
    }
  });

  it('custody says plainly that it has no independent fallback', async () => {
    const down = await stubGateway((_req, res) => badGateway(res));
    try {
      const r = await certen(['--json', 'proof', 'custody', PROOF], down.url);
      expect(r.code).toBe(1);
      const err = soleJson(r.stdout).error as { message: string };
      // Honest about the difference: the receipt can substitute for a proof read, and cannot
      // substitute for custody.
      expect(err.message).toMatch(/no independent fallback/);
    } finally {
      await down.close();
    }
  });
});

describe('proof bundle writes what actually arrived', () => {
  it('writes JSON with a .json extension when the gateway sends JSON', async () => {
    const stub = await stubGateway((req, res) => {
      if ((req.url ?? '').endsWith('/bundle')) return json(res, 200, { bundle: true, proof_id: PROOF });
      return json(res, 404, {});
    });
    try {
      const r = await certen(['--json', 'proof', 'bundle', PROOF], stub.url);
      expect(r.code).toBe(0);
      const data = soleJson(r.stdout).data as { path: string; content_type: string; bytes: number };
      expect(data.path).toMatch(/\.json$/);
      expect(data.bytes).toBeGreaterThan(0);
      const written = join(r.home, `proof-${PROOF}.json`);
      expect(existsSync(written)).toBe(true);
      expect(JSON.parse(readFileSync(written, 'utf8'))).toMatchObject({ bundle: true });
    } finally {
      await stub.close();
    }
  });

  it('writes .bin when the gateway streams octet-stream', async () => {
    const stub = await stubGateway((req, res) => {
      if ((req.url ?? '').endsWith('/bundle')) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/octet-stream');
        return res.end(Buffer.from([0x00, 0x01, 0x02, 0x03]));
      }
      return json(res, 404, {});
    });
    try {
      const r = await certen(['--json', 'proof', 'bundle', PROOF], stub.url);
      expect(r.code).toBe(0);
      // The extension follows the response, because the guide is explicit that the bundle is
      // sometimes binary and sometimes JSON — so assuming either one is wrong half the time.
      expect((soleJson(r.stdout).data as { path: string }).path).toMatch(/\.bin$/);
    } finally {
      await stub.close();
    }
  });

  it('honours --out', async () => {
    const stub = await stubGateway((req, res) => {
      if ((req.url ?? '').endsWith('/bundle')) return json(res, 200, { bundle: true });
      return json(res, 404, {});
    });
    try {
      const r = await certen(['--json', 'proof', 'bundle', PROOF, '--out', 'custom.json'], stub.url);
      expect(r.code).toBe(0);
      expect(existsSync(join(r.home, 'custom.json'))).toBe(true);
    } finally {
      await stub.close();
    }
  });
});

describe('proof verify states what it did NOT check', () => {
  it('never claims more than the gateway asserted', async () => {
    const stub = await stubGateway(proofServiceDown());
    try {
      const r = await certen(['--json', 'proof', 'verify', INTENT], stub.url);
      expect(r.code).toBe(0);
      const data = soleJson(r.stdout).data as {
        checked: { inclusion: string; authorization: string; outcome: string };
        independent: boolean;
      };
      // Inclusion came from the gateway, so it is reported as asserted BY the gateway — not as
      // "verified". The other two were not attempted at all and say so.
      expect(data.checked.inclusion).toMatch(/asserted by the gateway/);
      expect(data.checked.authorization).toMatch(/NOT CHECKED/);
      expect(data.checked.outcome).toMatch(/NOT CHECKED/);
      // The load-bearing field: asking the gateway is not independent verification.
      expect(data.independent).toBe(false);
    } finally {
      await stub.close();
    }
  });

  it('tells a human that a valid proof of the WRONG call is still a valid proof', async () => {
    const stub = await stubGateway(proofServiceDown());
    try {
      const r = await certen(['proof', 'verify', INTENT], stub.url);
      const out = r.stdout + r.stderr;
      expect(out).toMatch(/valid proof of the WRONG call/);
      expect(out).toMatch(/not independent verification/);
    } finally {
      await stub.close();
    }
  });

  it('fails when the transaction is delivered but NOT anchored', async () => {
    const stub = await stubGateway((req, res) => {
      const url = (req.url ?? '').split('?')[0];
      if (url === `/v1/transaction/${INTENT}`) return json(res, 200, COMPLETED_INTENT);
      if (url === `/v1/proof/tx/${HASH}/receipt`) {
        // Delivered and anchored are different claims. Without an anchor there is no root a
        // counterparty can check against, so inclusion is not established.
        return json(res, 200, { ...RECEIPT, anchored: false, receipt: null });
      }
      return json(res, 404, {});
    });
    try {
      const r = await certen(['--json', 'proof', 'verify', INTENT], stub.url);
      expect(r.code).toBe(1);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('INCLUSION_NOT_ESTABLISHED');
    } finally {
      await stub.close();
    }
  });

  it('reads a saved bundle from disk with @path', async () => {
    const home = mkdtempSync(join(tmpdir(), 'certen-proof-'));
    const path = join(home, 'bundle.json');
    writeFileSync(path, JSON.stringify({ tx_hash: HASH, receipt: RECEIPT.receipt, anchored: true }));
    const stub = await stubGateway(proofServiceDown());
    try {
      const r = await certen(['--json', 'proof', 'verify', `@${path}`], stub.url);
      expect(r.code).toBe(0);
      expect((soleJson(r.stdout).data as { independent: boolean }).independent).toBe(false);
    } finally {
      await stub.close();
    }
  });

  it('is a usage error when the bundle file cannot be read as JSON', async () => {
    const stub = await stubGateway(proofServiceDown());
    try {
      const r = await certen(['--json', 'proof', 'verify', '@nosuchfile.json'], stub.url);
      expect(r.code).toBe(2);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('UNREADABLE_BUNDLE');
    } finally {
      await stub.close();
    }
  });
});

describe('proof shares', () => {
  it('collapses three timestamps into one state column', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const stub = await stubGateway((req, res) => {
      if ((req.url ?? '').startsWith('/v1/proof/shares')) {
        return json(res, 200, {
          shares: [
            { id: 'a', proof_id: PROOF, label: 'revoked one', revoked_at: past, expires_at: future, view_count: 1 },
            { id: 'b', proof_id: PROOF, label: 'expired one', revoked_at: null, expires_at: past, view_count: 0 },
            { id: 'c', proof_id: PROOF, label: 'live one', revoked_at: null, expires_at: future, view_count: 3 },
          ],
        });
      }
      return json(res, 404, {});
    });
    try {
      const r = await certen(['--json', 'proof', 'shares'], stub.url);
      expect(r.code).toBe(0);
      const rows = soleJson(r.stdout).data as Array<{ id: string; state: string }>;
      // "Can someone use this right now" is one question, and the gateway answers it with three
      // separate timestamps the reader has to combine.
      expect(rows.map((x) => x.state)).toEqual(['revoked', 'expired', 'active']);
    } finally {
      await stub.close();
    }
  });

  it('revokes a link and says the proof itself is untouched', async () => {
    const stub = await stubGateway((req, res) => {
      if (req.method === 'DELETE') return json(res, 200, { revoked: true });
      return json(res, 404, {});
    });
    try {
      const r = await certen(['proof', 'shares', 'revoke', 'share-1'], stub.url);
      expect(r.code).toBe(0);
      expect(r.stdout + r.stderr).toMatch(/proof is unaffected/);
    } finally {
      await stub.close();
    }
  });
});

describe('certen proof open — the counterparty command', () => {
  const SHARED = {
    proof_id: 'p1', shared: true, expires_at: '2026-09-01T00:00:00.000Z',
    view_count: 1, bundle: { proof_id: 'p1', anchors: [{ chain: 'base-sepolia' }] },
  };

  /** Deliberately WITHOUT CERTEN_API_KEY or CERTEN_API_URL — a counterparty has neither. */
  async function bare(args: string[]): Promise<Run> {
    const home = mkdtempSync(join(tmpdir(), 'certen-share-'));
    const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, USERPROFILE: home };
    delete env.CERTEN_API_KEY;
    delete env.CERTEN_API_URL;
    try {
      const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env, encoding: 'utf8', cwd: home });
      return { stdout, stderr, code: 0, home };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1, home };
    }
  }

  it('works with NO API key configured on the machine', async () => {
    // The whole point. Every other proof-share command is for the sender; this is the one the
    // recipient runs, and they have no CERTEN account — so requiring a key would make the command
    // useless to exactly the person it exists for.
    const srv = await stubGateway((req, res) => json(res, 200, SHARED));
    try {
      const r = await bare(['proof', 'open', `${srv.url}/v1/proof/shared/tok_abc`, '--json']);
      expect(r.code).toBe(0);
      const data = soleJson(r.stdout).data as Record<string, unknown>;
      expect(data.proof_id).toBe('p1');
    } finally {
      await srv.close();
    }
  });

  it('writes the bundle to a file with --out', async () => {
    const srv = await stubGateway((req, res) => json(res, 200, SHARED));
    try {
      const r = await bare(['proof', 'open', `${srv.url}/v1/proof/shared/tok_abc`, '--out', 'b.json', '--json']);
      expect(r.code).toBe(0);
      const written = JSON.parse(readFileSync(join(r.home, 'b.json'), 'utf8')) as { proof_id: string };
      expect(written.proof_id).toBe('p1');
    } finally {
      await srv.close();
    }
  });

  it('tells a recipient to ask for a fresh link rather than that the proof is missing', async () => {
    // A 410 means the link WAS real. Reporting it as "not found" would send a counterparty away
    // believing the proof does not exist.
    const srv = await stubGateway((req, res) =>
      json(res, 410, { error: 'This share link has expired.', code: 'SHARE_NO_LONGER_VALID' }));
    try {
      const r = await bare(['proof', 'open', `${srv.url}/v1/proof/shared/tok_abc`]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/ask for a new link/);
    } finally {
      await srv.close();
    }
  });

  it('rejects a link that is not a share link without making a request', async () => {
    const r = await bare(['proof', 'open', 'https://example.com/nope']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not a share link/);
  });
});
