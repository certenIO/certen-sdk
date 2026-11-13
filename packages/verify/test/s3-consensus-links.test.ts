import { describe, expect, it } from 'vitest';
import { decodeEvidenceFull, evidence20View, marshalEvidence, unmarshalCertifiedEvidence } from '../src/s3/consensus.js';

/**
 * The evidence form a certificate carries (validator pkg/proof/v2 Evidence) has had the members `links` and `genesisLink` since RB9-F5 (evidence 2.1 only). The
 * certificate decode of this package did not list them, so a 2.1 document that carried them was decoded lossily and written back without them. They sit between
 * `transaction` and `check` in Go's struct, so that is where json.Marshal writes them; a document that claims 2.0 is decoded into the members v14 kept, which are
 * neither of them.
 */
const doc = (version: string): string => `{"version":"${version}","account":"acc://a.acme/data","txHash":"00","receipt":"","majors":0,"certify":null,"anchor":{"message":"","receipt":""},"transaction":"ab","links":["0102","0304"],"genesisLink":"0506","check":{"majors":0,"hops":null,"set":{"incarnation":"","network":{"accountUrl":"","accountState":"","stateReceipt":{"start":"","anchor":"","localBlock":0,"entries":null},"chains":null,"secondaryHash":"","pendingHash":""},"globals":{"accountUrl":"","accountState":"","stateReceipt":{"start":"","anchor":"","localBlock":0,"entries":null},"chains":null,"secondaryHash":"","pendingHash":""}}}}`;

describe('the certificate evidence form carries links and genesisLink (evidence 2.1)', () => {
  it('a document that claims 2.1 keeps both members and writes them between transaction and check', () => {
    const text = doc('2.1');
    const full = decodeEvidenceFull(text);
    expect(full.Links).toEqual(['0102', '0304']);
    expect(full.GenesisLink).toBe('0506');
    expect(marshalEvidence(full)).toBe(text);
    expect(marshalEvidence(unmarshalCertifiedEvidence(text))).toBe(text);
  });

  it('a document that claims 2.0 is decoded into the members v14 kept: neither is kept, and the 2.0 view has neither', () => {
    const cert = unmarshalCertifiedEvidence(doc('2.0'))!;
    expect(cert.Links).toBeNull();
    expect(cert.GenesisLink).toBe('');
    const view = evidence20View(decodeEvidenceFull(doc('2.1')))!;
    expect(view.Links).toBeNull();
    expect(view.GenesisLink).toBe('');
  });
});
