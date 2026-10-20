/**
 * The vector set under test is exactly the validator's finality_ethl1_v2 at certen-validator pv2/rb11-int@21e7a94: its manifest is
 * pinned by hash, every file the manifest lists has the listed hash and size, no other file is present, and the cases the Go suite
 * requires are all there.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GO_COMMIT, SET, V2_MANIFEST_SHA256, caseIds, loadCase, readSet, sha256Hex } from './helpers.js';

describe('finality_ethl1_v2 manifest', () => {
  it('pins manifest.json, MANIFEST.sha256 and every listed file; no file is unlisted', () => {
    expect(GO_COMMIT.startsWith('21e7a94')).toBe(true);
    expect(sha256Hex(readSet('manifest.json'))).toBe(V2_MANIFEST_SHA256);
    expect(readSet('MANIFEST.sha256').toString('utf8')).toBe(`${V2_MANIFEST_SHA256}  manifest.json\n`);
    const m = JSON.parse(readSet('manifest.json').toString('utf8')) as { files: { path: string; sha256: string; bytes: number }[]; cases: string[] };
    const listed = new Set<string>();
    for (const f of m.files) {
      const b = readSet(f.path);
      expect(sha256Hex(b), f.path).toBe(f.sha256);
      expect(b.length, f.path).toBe(f.bytes);
      listed.add(f.path);
    }
    expect(listed.size).toBe(311);
    const onDisk: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else onDisk.push(p.slice(SET.length + 1).split('\\').join('/'));
      }
    };
    walk(SET);
    expect(onDisk.filter((f) => f !== 'manifest.json' && f !== 'MANIFEST.sha256' && f !== 'SUPERSEDED.md').sort()).toEqual([...listed].sort());
    expect(m.cases.length).toBe(143);
  });

  it('has 128 head and 15 covers cases, including every case the Go suite requires', () => {
    const ids = caseIds();
    const kinds = ids.map((id) => loadCase(id).kind);
    expect(kinds.filter((k) => k === 'head').length).toBe(128);
    expect(kinds.filter((k) => k === 'covers').length).toBe(15);
    const required = [
      'valid_k1_k0', 'valid_k2_k0', 'valid_k1_short', 'valid_k1_chain', 'adv_participation_341', 'adv_window_exceeded', 'adv_learned_committee_not_ledger',
      'synth_valid_342_exact', 'synth_valid_fork_boundary_domain', 'synth_valid_electra_era_finalized_header',
      'valid_k2_fulu_k0', 'valid_k1_fulu_k0', 'valid_k2_fulu_chain_to_gloas', 'valid_k1_fulu_chain_to_gloas',
      'adv_electra_forged_attested_exec_field', 'adv_electra_forged_finalized_exec_field', 'adv_electra_forged_attested_exec_branch_node',
      'adv_electra_forged_finalized_exec_branch_node', 'adv_electra_forged_finality_branch_node', 'adv_electra_attested_slot_in_gloas_era',
      'adv_electra_extra_data_offset_lie', 'adv_electra_execution_offset_lie', 'adv_electra_attested_offset_lie', 'adv_electra_finalized_offset_out_of_range',
      'adv_electra_finalized_offset_descending', 'adv_electra_overlong_tail', 'adv_electra_extra_data_grown_by_one', 'adv_electra_truncated',
      'adv_electra_layout_byte_gloas_on_electra_bytes', 'adv_gloas_layout_byte_electra_on_gloas_bytes', 'adv_electra_bootstrap_layout_byte_gloas',
      'adv_electra_fork_version_wrong', 'adv_electra_bootstrap_forged_exec_field', 'adv_electra_bootstrap_committee_branch_forged',
      'adv_electra_bootstrap_committee_swapped', 'adv_electra_ledger_1378_committee_wrong', 'adv_electra_chain_learned_not_ledger',
      'adv_electra_link_signature_flipped', 'adv_electra_link_next_committee_branch_forged', 'adv_electra_link_next_committee_forged',
      'adv_electra_link_participation_341', 'adv_electra_link_finality_branch_forged', 'adv_electra_link_attested_offset_lie',
      'adv_electra_link_finalized_offset_out_of_range', 'adv_electra_link_execution_offset_lie', 'adv_electra_link_extra_data_offset_lie',
      'adv_electra_link_truncated', 'adv_electra_link_overlong_tail', 'adv_electra_link_forged_attested_exec_field',
      'adv_electra_link_forged_finalized_exec_field', 'adv_electra_link_attested_slot_in_gloas_era', 'adv_electra_bootstrap_header_offset_lie',
      'adv_electra_bootstrap_truncated', 'adv_electra_bootstrap_execution_offset_lie', 'adv_electra_bootstrap_extra_data_offset_lie',
      'adv_electra_bootstrap_overlong_tail', 'adv_electra_anchor_body_layout_byte_electra', 'synth_valid_link_then_final',
      'adv_synth_next_committee_mismatch', 'adv_synth_final_period_gap_next_known', 'adv_synth_link_period_skip_next_known',
      'synth_valid_nonparticipating_invalid_key', 'adv_synth_participating_invalid_key', 'adv_synth_final_finalized_slot_zero', 'adv_pins_network_mismatch',
      'adv_ledger_period_1380_altered', 'adv_ledger_period_1385_altered', 'adv_ledger_period_1390_altered',
      'spine_valid_20', 'spine_legacy_leg', 'adv_spine_legacy_leg_over_bound', 'spine_legacy_block_above_head',
    ];
    for (const id of required) expect(ids, id).toContain(id);
    // the README names the set the port consumes
    expect(readFileSync(join(SET, 'README.md'), 'utf8')).toContain('finality_ethl1_v2');
  });
});
