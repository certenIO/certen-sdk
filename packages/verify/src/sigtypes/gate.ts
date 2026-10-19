/**
 * The executor-version gate, as the validator's govsig/gate.go applies it - the same table, the same decisions, the same names.
 *
 * Some of the nine types are not always registered with Accumulate's executor, and one verifies by a different rule before a
 * version:
 *
 *     rsaSha256, ecdsaSha256, typedData   registered only at executor version >= v2-vandenberg   (sig_user.go:20-43)
 *     eth, the raw 64/65-byte r||s rule   only at executor version >= v2-baikonur                (sig_user.go:108-112)
 *
 * A signature's block is a block of ONE partition, and each partition (the Directory and every BVN) activated a version at its
 * own block, so the gate is a pure function of (partition, block) against the activation table below. The table is what the
 * Kermit system ledgers show (research R8, measurement M5): each partition has exactly two entries on its main chain, a
 * systemGenesis and one activateProtocolVersion v2-kourou. The version before the activation is the genesis version, which the
 * public API cannot show; it is not assumed. So a signature recorded after a partition's activation block is proven to have
 * been judged by an executor that had both rules; at or before it - or with no location at all, or on a partition not in the
 * table - the version is UNPROVEN, which is a named state and never an acceptance. The activation block itself counts as not
 * yet proven: the table records the block in which the activation message was received.
 */
import { goLower, goTrimSpace, sha256 } from '../proof-v2/bytes.js';

/** accumulate protocol.ExecutorVersion values (protocol/enums.yml). */
export const ExecutorVersion = { V2Baikonur: 6, V2Vandenberg: 7, V2Jiuquan: 8, V2Kourou: 9 } as const;
export type ExecutorVersionName = 'v2-baikonur' | 'v2-vandenberg' | 'v2-jiuquan' | 'v2-kourou';
const VERSION_NAMES: Readonly<Record<number, ExecutorVersionName>> = {
  6: 'v2-baikonur',
  7: 'v2-vandenberg',
  8: 'v2-jiuquan',
  9: 'v2-kourou',
};
const versionName = (v: number): string => VERSION_NAMES[v] ?? `version ${v}`;

export interface Activation {
  version: number;
  /** The partition's local block in which the activation message was received. */
  block: number;
  /** That block's localBlockTime, UTC (informational). */
  time?: string;
}

/**
 * Kermit's activations at the pinned Accumulate commit e1d1db9ebb7c. A later activation on any partition needs a row here and a
 * library bump, exactly as protocol.ExecutorVersionLatest needs one.
 */
export const KERMIT_ACTIVATIONS: Readonly<Record<string, Activation>> = {
  directory: { version: ExecutorVersion.V2Kourou, block: 9_538_105, time: '2026-09-21T15:30:10Z' },
  bvn1: { version: ExecutorVersion.V2Kourou, block: 12_491_272 },
  bvn2: { version: ExecutorVersion.V2Kourou, block: 12_492_057 },
  bvn3: { version: ExecutorVersion.V2Kourou, block: 12_491_127 },
};

/** Where a signature was recorded: a partition and that partition's local block. */
export interface Where {
  partition: string;
  block: number | bigint;
}

export function normalizePartition(p: string): string {
  const s = goLower(goTrimSpace(p));
  return s === 'dn' || s === 'directory' || s === 'dn.acme' ? 'directory' : s;
}

function activationOf(partition: string): Activation | undefined {
  return Object.prototype.hasOwnProperty.call(KERMIT_ACTIVATIONS, partition) ? KERMIT_ACTIVATIONS[partition] : undefined;
}

/** The lowest executor version PROVEN to govern a block of a partition; undefined when it follows no known activation. */
export function executorFloor(partition: string, block: number | bigint): number | undefined {
  const a = activationOf(normalizePartition(partition));
  if (!a || BigInt(block) <= BigInt(a.block)) return undefined;
  return a.version;
}

export const EthRule = { None: '', V2RSV: 'v2-rsv', V1DER: 'v1-der' } as const;
export type EthRuleName = (typeof EthRule)[keyof typeof EthRule];

/** The executor version a signature of this Go type name needs; 0 means the type is always registered and has one rule. */
export function requiredVersion(typeName: string, rule: EthRuleName): number {
  switch (typeName) {
    case 'rsaSha256':
    case 'ecdsaSha256':
    case 'typedData':
      return ExecutorVersion.V2Vandenberg;
    case 'eth':
      return rule === EthRule.V2RSV ? ExecutorVersion.V2Baikonur : 0;
  }
  return 0;
}

/** The named state: the type needs an executor version the evidence does not prove at the block it was recorded in. */
export class ExecutorVersionUnproven extends Error {
  readonly verdict = 'named:g1_executor_version_unproven';
  constructor(
    readonly type: string,
    readonly partition: string,
    readonly block: number | bigint,
    readonly needs: string,
    readonly earliestKnown: number,
  ) {
    const where = partition === '' || BigInt(block) <= 0n ? 'an unknown partition/block (the evidence names none)' : `partition "${partition}" block ${block}`;
    super(
      `g1_executor_version_unproven{type=${type}, partition="${partition}", block=${block}}: a ${type} signature needs executor version ${needs}, and the version in force at ${where} is not proven (the pinned activation table proves it only after block ${earliestKnown} of that partition). This is NOT a governance rejection and the signature is NOT counted`,
    );
  }
}

/** The evidence is inconsistent with Accumulate's rules: the executor is proven to have been at a version that could not have accepted this form. */
export class ExecutorGateNotMet extends Error {
  readonly verdict = 'refused:executor_gate_not_met';
  constructor(
    readonly type: string,
    readonly partition: string,
    readonly block: number | bigint,
    readonly proven: string,
    readonly why: string,
  ) {
    super(`executor_gate_not_met{type=${type}, partition="${partition}", block=${block}, version=${proven}}: ${why}`);
  }
}

/** govsig.CheckExecutorGate: type name (Go spelling), the eth rule the signature verified under, and where it was recorded. */
export function checkExecutorGate(typeName: string, rule: EthRuleName, where: Where | undefined): void {
  const partition = normalizePartition(where?.partition ?? '');
  const block = where?.block ?? 0;
  const need = requiredVersion(typeName, rule);
  const floor = executorFloor(partition, block);

  // An eth signature in the pre-Baikonur DER form could only have been accepted while the executor was below v2-baikonur.
  if (typeName === 'eth' && rule === EthRule.V1DER) {
    if (floor !== undefined && floor >= ExecutorVersion.V2Baikonur) {
      throw new ExecutorGateNotMet(
        'eth(der)',
        partition,
        block,
        versionName(floor),
        'the executor was already at v2-baikonur or later, which verifies eth by the raw r||s rule only; a DER-form eth signature cannot have been accepted there',
      );
    }
    return;
  }

  if (need === 0) return;
  if (floor === undefined) throw new ExecutorVersionUnproven(typeName, partition, block, versionName(need), activationOf(partition)?.block ?? 0);
  if (floor < need) throw new ExecutorGateNotMet(typeName, partition, block, versionName(floor), `needs ${versionName(need)}`);
}

/** EthChainID(name): the EIP-155 chain id Accumulate derives from a network name (protocol/signature_eip712.go). */
export function ethChainId(networkName: string): bigint {
  if (networkName.toLowerCase() === 'mainnet') return 281n;
  const hash = sha256(new TextEncoder().encode(networkName.toLowerCase()));
  const id = BigInt((hash[hash.length - 2]! << 8) | hash[hash.length - 1]!);
  return 281n | (id << 16n);
}
