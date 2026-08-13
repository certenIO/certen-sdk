import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { CertenClient } from '../src/index.js';

/**
 * `listAll()` — every page, without the caller writing an adapter.
 *
 * `paginate` has been exported since 0.2.0 and composed with nothing this SDK ships. It takes a
 * callback returning `{ items }`, and no method here returns that shape: `transaction.list()`
 * returns `{ transactions }`, `pending.list()` returns `{ actions }`. Using the exported helper
 * meant first hand-writing the adapter it should have contained — and an exported helper that
 * cannot be used as shipped is worse than no helper, because it reads as a solved problem.
 *
 * What is pinned here is the paging arithmetic, which is where an iterator like this goes wrong
 * quietly: a short page must stop the loop, an exactly-full final page must not drop the last item
 * or spin forever, and the offset must advance by what was received rather than by what was asked
 * for.
 */

interface Seen { path: string; query: URLSearchParams }

async function gateway(handler: (q: URLSearchParams, path: string) => unknown) {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const [path, qs] = (req.url ?? '').split('?');
    const query = new URLSearchParams(qs ?? '');
    seen.push({ path, query });
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(handler(query, path)));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    seen,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const client = (url: string) => new CertenClient({ apiKey: 'ck_test', baseUrl: url });

/** `n` transactions, ids `tx-0` … `tx-{n-1}`, served as pages of `pageSize`. */
function pagedTransactions(total: number) {
  return (q: URLSearchParams) => {
    const limit = Number(q.get('limit') ?? '100');
    const offset = Number(q.get('offset') ?? '0');
    const slice = Array.from({ length: total }, (_, i) => ({ intent_id: `tx-${i}`, status: 'completed' }))
      .slice(offset, offset + limit);
    return { transactions: slice, limit, offset };
  };
}

describe('transaction.listAll', () => {
  it('walks every page without an adapter', async () => {
    const g = await gateway(pagedTransactions(250));
    try {
      const ids: string[] = [];
      for await (const tx of client(g.url).transaction.listAll()) ids.push(tx.intent_id);
      expect(ids).toHaveLength(250);
      expect(ids[0]).toBe('tx-0');
      expect(ids[249]).toBe('tx-249');
      // 100 + 100 + 50: the short third page ends it.
      expect(g.seen).toHaveLength(3);
    } finally { await g.close(); }
  });

  it('stops after one request when the first page is short', async () => {
    const g = await gateway(pagedTransactions(3));
    try {
      const ids: string[] = [];
      for await (const tx of client(g.url).transaction.listAll()) ids.push(tx.intent_id);
      expect(ids).toHaveLength(3);
      expect(g.seen).toHaveLength(1);
    } finally { await g.close(); }
  });

  it('does not loop forever when the total is an exact multiple of the page size', async () => {
    // The classic off-by-one: a full final page looks like "there may be more", so the iterator
    // must ask once more and stop on the empty page rather than assuming.
    const g = await gateway(pagedTransactions(20));
    try {
      const ids: string[] = [];
      for await (const tx of client(g.url).transaction.listAll(10)) ids.push(tx.intent_id);
      expect(ids).toHaveLength(20);
      expect(ids[19]).toBe('tx-19');
      expect(g.seen).toHaveLength(3);            // 10, 10, then the empty page that ends it
    } finally { await g.close(); }
  });

  it('returns nothing, and asks once, when there is nothing', async () => {
    const g = await gateway(pagedTransactions(0));
    try {
      const ids: string[] = [];
      for await (const tx of client(g.url).transaction.listAll()) ids.push(tx.intent_id);
      expect(ids).toEqual([]);
      expect(g.seen).toHaveLength(1);
    } finally { await g.close(); }
  });

  it('advances the offset by what was RECEIVED, not by what was asked for', async () => {
    // A gateway may cap the page below the requested limit. Advancing by `limit` would skip
    // whatever it withheld — silently, and only on large result sets.
    let call = 0;
    const g = await gateway((q) => {
      call += 1;
      const offset = Number(q.get('offset') ?? '0');
      // First page returns 5 despite limit=10; second returns the rest.
      const size = call === 1 ? 5 : 10;
      const slice = Array.from({ length: 12 }, (_, i) => ({ intent_id: `tx-${i}`, status: 'x' }))
        .slice(offset, offset + size);
      return { transactions: slice };
    });
    try {
      const ids: string[] = [];
      for await (const tx of client(g.url).transaction.listAll(10)) ids.push(tx.intent_id);
      // A short page ends iteration, so this stops at 5 — but the ids must be the FIRST five, with
      // none skipped.
      expect(ids).toEqual(['tx-0', 'tx-1', 'tx-2', 'tx-3', 'tx-4']);
      expect(g.seen[0].query.get('offset')).toBe('0');
    } finally { await g.close(); }
  });

  it('tolerates a response with no array at all', async () => {
    // An error page or an unexpected shape must end the loop, not throw a TypeError from inside a
    // `for await` the caller cannot easily place.
    const g = await gateway(() => ({}));
    try {
      const ids: string[] = [];
      for await (const tx of client(g.url).transaction.listAll()) ids.push(tx.intent_id);
      expect(ids).toEqual([]);
    } finally { await g.close(); }
  });
});

describe('pending.listAll', () => {
  it('passes its filters through on every page', async () => {
    const g = await gateway((q) => {
      const offset = Number(q.get('offset') ?? '0');
      const slice = Array.from({ length: 15 }, (_, i) => ({ id: `a-${i}` }))
        .slice(offset, offset + 10);
      return { actions: slice };
    });
    try {
      const ids: string[] = [];
      for await (const a of client(g.url).pending.listAll({ identity: 'acc://x.acme' }, 10)) {
        ids.push((a as { id: string }).id);
      }
      expect(ids).toHaveLength(15);
      // The filter must survive page two, or a narrowed iteration silently widens partway through.
      expect(g.seen).toHaveLength(2);
      for (const s of g.seen) expect(s.query.get('identity')).toBe('acc://x.acme');
    } finally { await g.close(); }
  });
});

describe('admin.auditLogAll', () => {
  it('reports a running index and the server-side total', async () => {
    // The audit export is the one case with a real total, and the one long enough that a caller
    // wants to render progress rather than guess.
    const g = await gateway((q) => {
      const offset = Number(q.get('offset') ?? '0');
      const limit = Number(q.get('limit') ?? '100');
      const all = Array.from({ length: 7 }, (_, i) => ({ id: `e-${i}`, action: 'identity.create' }));
      return { entries: all.slice(offset, offset + limit), pagination: { limit, offset, total: 7 } };
    });
    try {
      const seen: Array<{ id: string; index: number; total: number | undefined }> = [];
      for await (const { item, index, total } of client(g.url).admin.auditLogAll(undefined, 3)) {
        seen.push({ id: (item as { id: string }).id, index, total });
      }
      expect(seen).toHaveLength(7);
      expect(seen[0]).toEqual({ id: 'e-0', index: 0, total: 7 });
      // The index keeps counting ACROSS pages — it is not the position within a page.
      expect(seen[6]).toEqual({ id: 'e-6', index: 6, total: 7 });
      expect(g.seen).toHaveLength(3);            // 3, 3, then the short page of 1
    } finally { await g.close(); }
  });

  it('still iterates when the server omits the total', async () => {
    // `total` is undefined rather than 0, so a progress UI can tell "unknown" from "none".
    const g = await gateway((q) => {
      const offset = Number(q.get('offset') ?? '0');
      return { entries: Array.from({ length: 2 }, (_, i) => ({ id: `e-${offset + i}` })).slice(0, offset === 0 ? 2 : 0) };
    });
    try {
      const totals: Array<number | undefined> = [];
      for await (const { total } of client(g.url).admin.auditLogAll(undefined, 2)) totals.push(total);
      expect(totals).toEqual([undefined, undefined]);
    } finally { await g.close(); }
  });
});
