import { baseBytes } from './s3-bytes.js';

/**
 * Documents for rb9-f6-duplicate-members.test.ts: the Go-written xpartition2 fixture valid-mixed-partition-g.json (it verifies) with one member written again.
 * Each builder is a string surgery on the compact text of the fixture, so the same document can be written out for cmd/xtsgen judgefile.
 */
export const DUP_BASE = 'xpartition2/valid-mixed-partition-g.json';
const text = baseBytes(DUP_BASE).toString('utf8');

/** The end (exclusive) of the JSON value that starts at `at`. */
function valueEnd(s: string, at: number): number {
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') {
      for (i++; s[i] !== '"'; i++) if (s[i] === String.fromCharCode(92)) i++; // a backslash escapes the next character
      if (depth === 0) return i + 1;
    } else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return s.length;
}

/** The first member `"name":` at or after `from`: [start of the key, start of the value, end of the value]. */
function member(name: string, from = 0): [number, number, number] {
  const key = `"${name}":`;
  const k = text.indexOf(key, from);
  if (k < 0) throw new Error(`the fixture has no ${key}`);
  const v = k + key.length;
  return [k, v, valueEnd(text, v)];
}
const after = (name: string, extra: string, from = 0): Buffer => {
  const [, , e] = member(name, from);
  return Buffer.from(text.slice(0, e) + ',' + extra + text.slice(e), 'utf8');
};
const before = (name: string, extra: string, from = 0): Buffer => {
  const [k] = member(name, from);
  return Buffer.from(text.slice(0, k) + extra + ',' + text.slice(k), 'utf8');
};

const evReceipt = text.indexOf('"receipt":{', text.indexOf('"txHash"'));
const [, entriesV, entriesE] = member('entries', evReceipt);
const nEntries = (JSON.parse(text.slice(entriesV, entriesE)) as unknown[]).length;
const empties = `[${Array(nEntries).fill('{}').join(',')}]`;
const bodyAt = text.indexOf('"body":{');
const [, anchorsV, anchorsE] = member('anchors');
const firstAnchor = (() => {
  const inner = text.slice(anchorsV + 1, anchorsE - 1);
  const k = inner.indexOf('":') + 2;
  return inner.slice(0, valueEnd(inner, k));
})();

// the key signatures of the first minor-root record of the certify walk: a list of unions (encoding.JsonUnmarshalListWith)
const certifyAt = text.indexOf('"certify":[');
const [, sigsV, sigsE] = member('signatures', certifyAt);
const sigEls: string[] = [];
for (let i = sigsV + 1; i < sigsE - 1; ) {
  const e = valueEnd(text, i);
  sigEls.push(text.slice(i, e));
  i = e + 1; // the comma
}
const sigFirst = sigEls[0]!;
const sigLast = sigEls[sigEls.length - 1]!;

export const dupMembers: [string, () => Buffer][] = [
  ['the base document', () => Buffer.from(text, 'utf8')],
  ['pages: [{}] after the list', () => after('pages', '"pages":[{}]')],
  ['receipt entries: [{}] after the list', () => after('entries', '"entries":[{}]', evReceipt)],
  ['receipt entries: [{}] then n empty objects (the slots past the length keep what the list left)', () => after('entries', `"entries":[{}],"entries":${empties}`, evReceipt)],
  ['receipt entries: [] then n empty objects (an empty list starts a new slice)', () => after('entries', `"entries":[],"entries":${empties}`, evReceipt)],
  ['receipt entries: null then n empty objects (a null starts a new slice)', () => after('entries', `"entries":null,"entries":${empties}`, evReceipt)],
  ['anchors: the first anchor again after the map (a map takes the entries and drops none)', () => after('anchors', `"anchors":{${firstAnchor}}`)],
  ['keys of a page account: [{}] after the list', () => after('keys', '"keys":[{}]')],
  ['the type of a transaction body: "" before the name', () => before('type', '"type":""', bodyAt)],
  ['the type of a transaction body: a name that is not the enum\'s after the name', () => after('type', '"type":"x"', bodyAt)],
  // a bare element as the second occurrence of a list of unions: UnmarshalJSON runs unmarshalList first, which takes it as a list of one written over index 0, so the rest stays
  ['signatures of a certify run: the first signature bare after the list ([A,B] then A: the list is intact)', () => after('signatures', `"signatures":${sigFirst}`, certifyAt)],
  ['signatures of a certify run: the first signature bare before the list (A then [A,B])', () => before('signatures', `"signatures":${sigFirst}`, certifyAt)],
  ['signatures of a certify run: the last signature bare after the list ([A,B] then B: [B,B])', () => after('signatures', `"signatures":${sigLast}`, certifyAt)],
];
