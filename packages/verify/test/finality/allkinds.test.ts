/**
 * The integration of the S7 stack: the finality barrel exports every chain package, registerAllKinds wires every ported Kind (Adiri failing
 * closed), the table has no row left without a Kind, and the embedded pins and state registry are the validator's
 * pv2/rb11-e1-raise@cbb6373 files, byte for byte.
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as barrel from '../../src/proof-v2/finality/index.js';
import { REGISTERED_KIND_NAMES, UNPORTED_KIND_ROWS, registerAllKinds } from '../../src/proof-v2/finality/allkinds.js';
import { Registry } from '../../src/proof-v2/finality/registry.js';
import { PINS_SHA256, embeddedPins, parsePinsOverride } from '../../src/proof-v2/finality/pins.js';
import { kindRows } from '../../src/proof-v2/finality/table.js';
import { FinalityStateError } from '../../src/proof-v2/finality/state.js';
import { parseBasePins as parseBasePostedPins } from '../../src/proof-v2/finality/baseposted/pins.js';
import { parseBasePins as parseBaseFinalPins } from '../../src/proof-v2/finality/basefinal/pins.js';
import { loadArbPins } from '../../src/proof-v2/finality/arbposted/pins.js';
import { parsePins as parseAdiriPins } from '../../src/proof-v2/finality/adiri/record.js';
import { sepoliaPins } from '../../src/proof-v2/finality/pins.js';
import { sha256Hex, readFixture } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const finalityDir = join(here, '..', '..', 'src', 'proof-v2', 'finality');

/** pv2/rb11-e1-raise@cbb6373 pkg/finality/testdata/finality/states.json and PinsSHA256 of pkg/finality/pins/finality-pins.json. */
const VALIDATOR_STATES_SHA256 = '4d3182ffcfbf5ec06d3a79bf08dd0a96c8c986299485f3a4db6d0e0b6325f52a';
const VALIDATOR_PINS_SHA256 = 'fdba733e7fc4206d96d73c87352834c51801ee8fe0af76d60654cb461fbd5440';
/** The registry finality_chain2's manifest pins; it moved to finality_chain2_registry/ when the current registry replaced it. */
const CHAIN2_STATES_SHA256 = 'd0e2d25048ba1dfe40e910538e6870675b2fbe3a4b0b47cdb9b1e0ffb084b73a';

const refusal = async (f: () => Promise<unknown>): Promise<FinalityStateError> => {
  try {
    await f();
  } catch (e) {
    if (e instanceof FinalityStateError) return e;
    throw e;
  }
  throw new Error('accepted');
};

describe('the finality barrel', () => {
  it('exports every chain package under its own namespace', () => {
    const dirs = readdirSync(finalityDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(finalityDir, d.name, 'index.ts')))
      .map((d) => d.name)
      .sort();
    expect(dirs).toEqual(['adiri', 'arbfinal', 'arbposted', 'basefinal', 'baseposted', 'ethl1', 'ethsepolia']);
    for (const d of dirs) {
      const ns = (barrel as Record<string, unknown>)[d];
      expect(typeof ns, d).toBe('object');
      expect(Object.keys(ns as object).length, d).toBeGreaterThan(0);
    }
  });
  it('exports the registrars and the framework', () => {
    expect(typeof barrel.adiri.registerAdiri).toBe('function');
    expect(typeof barrel.arbfinal.registerArbFinal).toBe('function');
    expect(typeof barrel.arbposted.registerArbPosted).toBe('function');
    expect(typeof barrel.basefinal.registerBaseFinal).toBe('function');
    expect(typeof barrel.baseposted.registerBasePosted).toBe('function');
    expect(typeof barrel.ethl1.verifyFinalizedHead).toBe('function');
    expect(typeof barrel.ethsepolia.registerEthSepolia).toBe('function');
    expect(typeof barrel.extendPins).toBe('function');
    expect(typeof barrel.verifyLedger).toBe('function');
    expect(typeof barrel.registerAllKinds).toBe('function');
    expect(typeof barrel.Registry).toBe('function');
    expect(typeof barrel.embeddedPins).toBe('function');
  });
});

describe('registerAllKinds', () => {
  it('registers the five ported Kinds under the embedded pins, each on its row of the table', async () => {
    const reg = new Registry();
    await registerAllKinds(reg, embeddedPins());
    const rows = new Map(kindRows().map((r) => [r.kind, r]));
    for (const name of REGISTERED_KIND_NAMES) {
      const k = reg.kind(name);
      expect(k, name).toBeDefined();
      expect(k!.name()).toBe(name);
      expect(k!.chain()).toBe(rows.get(name)!.chain);
      expect(k!.level()).toBe(rows.get(name)!.level);
    }
  });
  it('leaves no table row without a Kind, and the lists cover the table', async () => {
    const reg = new Registry();
    await registerAllKinds(reg, embeddedPins());
    const table = kindRows().map((r) => r.kind).sort();
    expect([...REGISTERED_KIND_NAMES, ...UNPORTED_KIND_ROWS].sort()).toEqual(table);
    expect(UNPORTED_KIND_ROWS).toEqual([]);
    for (const name of UNPORTED_KIND_ROWS) expect(reg.kind(name), name).toBeUndefined();
  });
  it('refuses a second registration and registers nothing new', async () => {
    const reg = new Registry();
    await registerAllKinds(reg, embeddedPins());
    await expect(registerAllKinds(reg, embeddedPins())).rejects.toThrow(/already has a verifier/);
  });
  it('fails closed when the pins cannot vouch for the embedded Adiri genesis link: nothing is registered', async () => {
    const text = readFileSync(join(finalityDir, 'finality-pins.json'), 'utf8');
    const link = JSON.parse(text).adiri.genesis_link_sha256 as string;
    const bad = parsePinsOverride(new TextEncoder().encode(text.replace(link, 'b'.repeat(64))));
    for (const pins of [bad, null, undefined]) {
      const reg = new Registry();
      const e = await refusal(() => registerAllKinds(reg, pins));
      expect(['finality_pins_corrupt', 'finality_pin_unknown']).toContain(e.code);
      for (const name of [...REGISTERED_KIND_NAMES]) expect(reg.kind(name), name).toBeUndefined();
    }
  });
});

describe('the pins and the state registry are the validator\'s', () => {
  it('PINS_SHA256 and the embedded pins are pkg/finality PinsSHA256 at pv2/rb11-e1-raise@cbb6373', () => {
    expect(PINS_SHA256).toBe(VALIDATOR_PINS_SHA256);
    expect(sha256Hex(readFileSync(join(finalityDir, 'finality-pins.json')))).toBe(VALIDATOR_PINS_SHA256);
  });
  it('finality/states.json is the validator\'s current registry and finality_chain2_registry/states.json the one its manifest pins', () => {
    expect(sha256Hex(readFixture('finality', 'states.json'))).toBe(VALIDATOR_STATES_SHA256);
    expect(sha256Hex(readFixture('finality_chain2_registry', 'states.json'))).toBe(CHAIN2_STATES_SHA256);
  });
});

describe("every ported kind's pins section loads from the embedded pins", () => {
  it.each([
    ["eth_sepolia", sepoliaPins],
    ["base_sepolia (l1_posted)", parseBasePostedPins],
    ["base_sepolia (finalized)", parseBaseFinalPins],
    ["arb_sepolia (l1_posted)", loadArbPins],
    ["adiri", parseAdiriPins],
  ] as const)("%s", (_name, load) => {
    expect(() => (load as (p: ReturnType<typeof embeddedPins>) => unknown)(embeddedPins())).not.toThrow();
  });
});
