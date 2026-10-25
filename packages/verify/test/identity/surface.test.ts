// The library entry identity.verifyContractIdentity(container, manifest, extension, legContext): the same verdict as the vector runner on vectors with an
// extension and with the embedded manifest, and a refused manifest_corrupt headline for manifest bytes that do not match the pin.
import { describe, expect, it } from 'vitest';
import { identity } from '../../src/index.js';
import { setFiles, vectorIds } from './fixtures.js';

const td = new TextDecoder();
function load(set: string, id: string): { inputs: identity.Inputs; expected: identity.Expected } {
  const files = setFiles(set);
  return { inputs: identity.loadMaterialised(td.decode(files.get(id + '.inputs.json')), files), expected: JSON.parse(td.decode(files.get(id + '.expected.json'))) as identity.Expected };
}

describe('identity.verifyContractIdentity', () => {
  it('judges vectors with an extension and with the embedded manifest as the runner does', () => {
    for (const set of ['s8_2c_3', 's8_int_3']) {
      for (const id of vectorIds(setFiles(set)).slice(0, 6)) {
        const { inputs, expected } = load(set, id);
        const report = identity.verifyContractIdentity(inputs.container, { raw: inputs.manifestRaw, pin: inputs.manifestPin }, inputs.extensionRaw, inputs.ctx);
        expect(identity.matchExpected(expected, report), set + '/' + id).toBeUndefined();
        expect(identity.canonicalReport(report).length).toBeGreaterThan(0);
      }
    }
  });

  it('refuses manifest bytes that are not the pinned ones, and never prints verified_core as verified', () => {
    const { inputs } = load('s8_int_3', vectorIds(setFiles('s8_int_3'))[0]!);
    const tampered = Uint8Array.from(inputs.manifestRaw);
    tampered[tampered.length >> 1] ^= 1;
    const r = identity.verifyContractIdentity(inputs.container, { raw: tampered }, undefined, inputs.ctx);
    expect(r.headline.kind).toBe('refused');
    expect(r.headline.first?.code).toBe('contract_identity_manifest_corrupt');
    expect(identity.reportObject(r)['headline']).toMatchObject({ code: 'contract_identity_refused' });
  });
});
