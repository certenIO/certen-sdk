import { describe, expect, it } from 'vitest';
import { defineChunks, readCorpus } from './helpers/s3-corpus.js';
import { AccUrl } from '../src/s3/acc.js';
import { executorFloorAt, executorOverrideTypes, hasExecutorOverride, kermitExecutorActivations, normalizeExecutorPartition } from '../src/s3/executor.js';
import { routePartition, type RoutingTable } from '../src/s3/routing.js';
import { TRANSACTION_TYPE_NAMES } from '../src/sigtypes/eip712-schema.js';

/**
 * The Go-written corpus of the pinned tables and the route function (cmd/xtsgen tables): the executor-version activation table (the fourth
 * pinned trust input of the proof), the partition-name normalisation, the executor-override table over every transaction type, and
 * RoutePartition over generated routing tables (prefix-free ones, overlapping, gapped, with bad lengths, with overrides) and a spread of accounts.
 */
const HASH = '617e200abd995c13fd6c1a900a6765a78cbc0cb756e40f6933c5672855120f48';

interface File {
  format: string;
  activations: Record<string, { version: number; block: number }>;
  floors: { partition: string; block: number; floor: number; ok: boolean }[];
  normalize: { in: string; out: string }[];
  overrides: { type: number; name: string; has: boolean }[];
  tables: { routes: { length: number; value: string; partition: string }[]; overrides: { account: string; partition: string }[] }[];
  routes: { table: number; account: string; partition?: string; err?: string }[];
}
const file = readCorpus<File>('go-written/tables-cases.json', HASH);

const capitalise = (s: string): string => s.slice(0, 1).toUpperCase() + s.slice(1);

describe('the pinned executor-version activation table, against Go', () => {
  it('is the table Go pins', () => {
    expect(kermitExecutorActivations()).toEqual(file.activations);
  });
  defineChunks(
    'the floor at and around every activation block, under every spelling',
    file.floors.map((f, i) => ({ id: `floor#${i}`, f })),
    ({ f }) => {
      const got = executorFloorAt(f.partition, f.block);
      const want = f.ok ? f.floor : undefined;
      return got === want ? [] : [`${JSON.stringify(f.partition)} block ${f.block}: Go ${want}; here ${got}`];
    },
    200,
  );
  defineChunks(
    'the partition spellings',
    file.normalize.map((n, i) => ({ id: `normalize#${i}`, n })),
    ({ n }) => (normalizeExecutorPartition(n.in) === n.out ? [] : [`${JSON.stringify(n.in)}: Go ${JSON.stringify(n.out)}; here ${JSON.stringify(normalizeExecutorPartition(n.in))}`]),
  );
});

describe('the executor-override table, against Go', () => {
  it('refuses exactly the body types Go refuses', () => {
    const goHas = file.overrides.filter((o) => o.has);
    expect(goHas.length).toBe(executorOverrideTypes().length);
    for (const o of goHas) {
      expect(TRANSACTION_TYPE_NAMES[o.type], `type ${o.type} (${o.name}) is known here`).toBe(o.name);
      expect(hasExecutorOverride(capitalise(o.name)), o.name).toBe(true);
    }
    for (const c of executorOverrideTypes()) expect(goHas.some((o) => capitalise(o.name) === c), c).toBe(true);
  });
  it('accepts every other type either side names', () => {
    for (const o of file.overrides) {
      if (o.has) continue;
      const known = TRANSACTION_TYPE_NAMES[o.type];
      if (known !== undefined) expect(hasExecutorOverride(capitalise(known)), `${o.type} ${known}`).toBe(false);
    }
  });
});

function tableOf(i: number): RoutingTable {
  const t = file.tables[i]!;
  return {
    routes: t.routes.map((r) => ({ length: r.length, value: BigInt(r.value), partition: r.partition })),
    overrides: t.overrides.map((o) => ({ ...(o.account !== '' ? { account: AccUrl.parse(o.account)! } : {}), partition: o.partition })),
  };
}

/** The class of a route refusal: the wording of a URL parser's error is the parser's. */
const klass = (m: string): string => (m.startsWith('account "') && !m.includes(' is unknown') ? 'account' : m);

describe('RoutePartition, against Go', () => {
  const tables = file.tables.map((_, i) => tableOf(i));
  defineChunks(
    'routes',
    file.routes.map((r, i) => ({ id: `route#${i} table ${r.table} ${JSON.stringify(r.account)}`, r })),
    ({ r }) => {
      let got: { partition?: string; err?: string };
      try {
        got = { partition: routePartition(tables[r.table]!, r.account) };
      } catch (e) {
        got = { err: (e as Error).message };
      }
      if (r.err !== undefined) return got.err !== undefined && klass(got.err) === klass(r.err) ? [] : [`Go refuses (${r.err}); here ${got.err !== undefined ? `refuses (${got.err})` : got.partition}`];
      return got.partition === r.partition ? [] : [`Go ${r.partition}; here ${got.partition ?? `refuses (${got.err})`}`];
    },
    300,
  );
});
