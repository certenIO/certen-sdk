import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { verifyPortable, VerifyError } from '../src/index.js';

/**
 * A document is untrusted JSON. A missing or malformed field must be a named VerifyError from the boundary, never a
 * TypeError, an `undefined` that reaches a hash, or a number coerced from nothing. Each case removes or corrupts one field the
 * verifier reads, in a document that otherwise verifies, and must be refused as a VerifyError.
 */
const dir = new URL('./fixtures/proofv2/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
const base = gunzipSync(readFileSync(new URL(manifest.base, dir))).toString('utf8');

type Path = (string | number)[];
function at(doc: any, path: Path): { parent: any; key: string | number } {
  let cur = doc;
  for (const k of path.slice(0, -1)) cur = cur[k];
  return { parent: cur, key: path[path.length - 1] };
}
const refuse = (mutate: (doc: any) => void) => {
  const doc = JSON.parse(base);
  mutate(doc);
  let err: unknown;
  try {
    verifyPortable(doc);
  } catch (e) {
    err = e;
  }
  expect(err, 'was accepted').toBeDefined();
  expect(err, String((err as Error)?.stack ?? err)).toBeInstanceOf(VerifyError);
};

const REQUIRED: Path[] = [
  ['pin'],
  ['genesis'],
  ['genesis', 'minorBlockIndex'],
  ['genesis', 'timeUnix'],
  ['genesis', 'rootChainAnchor'],
  ['genesis', 'networkRecord'],
  ['genesis', 'network'],
  ['genesis', 'globals'],
  ['majors', 0, 'anchor'],
  ['majors', 0, 'index'],
  ['majors', 0, 'entry'],
  ['majors', 0, 'entry', 'blockIndex'],
  ['majors', 0, 'anchor', 'source'],
  ['majors', 0, 'anchor', 'destination'],
  ['majors', 0, 'anchor', 'message'],
  ['majors', 0, 'anchor', 'message', 'transaction', 'header'],
  ['majors', 0, 'anchor', 'message', 'transaction', 'body', 'minorBlockIndex'],
  ['majors', 0, 'anchor', 'message', 'transaction', 'body', 'rootChainAnchor'],
  ['majors', 0, 'anchor', 'message', 'transaction', 'body', 'stateTreeAnchor'],
  ['majors', 1, 'signatures'],
  ['evidence'],
  ['evidence', 'majors'],
  ['evidence', 'txHash'],
  ['evidence', 'receipt'],
  ['evidence', 'certify'],
  ['evidence', 'anchor'],
  ['evidence', 'anchor', 'message'],
  ['evidence', 'anchor', 'receipt'],
  ['evidence', 'pages', 0, 'account'],
  ['evidence', 'pages', 0, 'receipt'],
  ['evidence', 'pages', 0, 'url'],
  ['evidence', 'check'],
  ['evidence', 'check', 'majors'],
  ['evidence', 'check', 'network'],
  ['evidence', 'check', 'globals'],
  ['evidence', 'check', 'network', 'record'],
  ['evidence', 'check', 'network', 'stateReceipt'],
  ['evidence', 'check', 'network', 'secondaryHash'],
  ['evidence', 'check', 'globals', 'pendingHash'],
];

describe('a missing field is a named refusal', () => {
  for (const p of REQUIRED) {
    it(`deleting ${p.join('.')}`, () => {
      refuse((doc) => {
        const { parent, key } = at(doc, p);
        delete parent[key];
      });
    }, 60000);
  }
});

describe('a malformed field is a named refusal', () => {
  const NUMERIC: Path[] = [
    ['genesis', 'minorBlockIndex'],
    ['genesis', 'timeUnix'],
    ['majors', 0, 'index'],
    ['majors', 0, 'entry', 'blockIndex'],
    ['majors', 0, 'anchor', 'message', 'transaction', 'body', 'minorBlockIndex'],
    ['evidence', 'majors'],
    ['evidence', 'check', 'majors'],
  ];
  for (const p of NUMERIC) {
    for (const bad of ['x', -1, 1.5, null, {}]) {
      it(`${p.join('.')} = ${JSON.stringify(bad)}`, () => {
        refuse((doc) => {
          const { parent, key } = at(doc, p);
          parent[key] = bad;
        });
      }, 60000);
    }
  }

  it('a hash of the wrong length where 32 bytes are required', () => {
    refuse((doc) => { doc.evidence.txHash = 'ab'; });
    refuse((doc) => { doc.majors[0].anchor.message.transaction.body.rootChainAnchor = 'ab'.repeat(31); });
    refuse((doc) => { doc.pin = 'zz'.repeat(32); });
  });

  it('a list where an object is required and the reverse', () => {
    refuse((doc) => { doc.evidence.anchor = []; });
    refuse((doc) => { doc.evidence.pages = {}; });
    refuse((doc) => { doc.majors = {}; });
    refuse((doc) => { doc.evidence.check = 'x'; });
    refuse((doc) => { doc.genesis = 7; });
  });
});
