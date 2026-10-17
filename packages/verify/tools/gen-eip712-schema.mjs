#!/usr/bin/env node
/**
 * Writes src/sigtypes/eip712-schema.ts from Accumulate's own Go source.
 *
 *   node tools/gen-eip712-schema.mjs <path to gitlab.com/accumulatenetwork/accumulate@v1.4.7-0.20260926030013-e1d1db9ebb7c>
 *
 * The EIP-712 type dictionary of a typedData signature is not written down anywhere as data: Accumulate builds it at start-up
 * from three places, and this script reads exactly those, so the TypeScript table is Accumulate's, not a transcription:
 *
 *   protocol/types_gen.go      every encoding.RegisterTypeDefinition(...) call: the fields (JSON name, EIP-712 type) of each
 *                              protocol struct, with its aliases;
 *   protocol/signature_eip712.go   the Transaction envelope (header, signature, then one field per user transaction body type,
 *                              TransactionType < TransactionMaxUser) and the SignatureMetadata definition (read by eye: its
 *                              nine fields are the literal list in that file's init());
 *   protocol/enums_gen.go + unions_gen.go   TransactionType.String() for the body field names, and the member tables of the
 *                              three unions registered with encoding.RegisterUnion (DataEntry, KeyPageOperation,
 *                              AccountAuthOperation): enum name -> struct name.
 *
 * The output is deterministic. The conformance test pins its sha256 so a regeneration that changes the table is a visible diff.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2];
if (!root) {
  console.error('usage: gen-eip712-schema.mjs <accumulate module dir>');
  process.exit(2);
}
const read = (p) => readFileSync(join(root, p), 'utf8');
const types = read('protocol/types_gen.go');
const enums = read('protocol/enums_gen.go');
const unions = read('protocol/unions_gen.go');
const eip = read('protocol/signature_eip712.go');

const COMMIT = 'e1d1db9ebb7c75318b6652293d5c7008da76ecf4';

// 1. RegisterTypeDefinition calls in protocol/types_gen.go.
const defs = {};
const re = /encoding\.RegisterTypeDefinition\(&\[\]\*encoding\.TypeField\{([\s\S]*?)\n\t\}, "([^"]+)"((?:, "[^"]+")*)\)/g;
for (let m = re.exec(types); m; m = re.exec(types)) {
  const fields = [...m[1].matchAll(/NewTypeField\("([^"]+)", "([^"]+)"\)/g)].map((x) => [x[1], x[2]]);
  if (defs[m[2]]) throw new Error(`duplicate definition ${m[2]}`);
  // RegisterTypeDefinition sorts by name with sort.Slice on a < b (byte order).
  defs[m[2]] = fields.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
if (Object.keys(defs).length !== 131) throw new Error(`expected 131 protocol definitions, found ${Object.keys(defs).length}`);

// 1b. Struct-valued (non-pointer) fields. Go's json omitempty does not omit a struct, so a zero struct-valued field is still in the
// JSON as {} - while on the wire (and in a pointer field) it is simply absent. The EIP-712 type includes such a field because the
// JSON has it, so the table is needed to put it back.
// Likewise a big.Int-valued (non-pointer) field is zero when absent, so a zero one on the wire is the same as none, while a *big.Int
// that is present (even zero) is kept.
const VALUE_STRUCTS = {};
const VALUE_BIGINTS = {};
for (const m of types.matchAll(/^type (\w+) struct \{\n([\s\S]*?)\n\}/gm)) {
  const [, struct, body] = m;
  if (!defs[struct]) continue;
  for (const line of body.split('\n')) {
    const f = /^\s+\w+\s+([A-Z]\w*)\s+`json:"([^",]+)/.exec(line);
    if (f && defs[f[1]]) (VALUE_STRUCTS[struct] ||= []).push([f[2], f[1]]);
    const b = /^\s+\w+\s+big\.Int\s+`json:"([^",]+)/.exec(line);
    if (b) (VALUE_BIGINTS[struct] ||= []).push(b[1]);
  }
}

// 2. SignatureMetadata, from signature_eip712.go init().
const sigMeta = [...eip.slice(eip.indexOf('encoding.RegisterTypeDefinition')).matchAll(/NewTypeField\("([^"]+)", "([^"]+)"\)/g)].map((x) => [x[1], x[2]]);
if (sigMeta.length !== 9) throw new Error(`SignatureMetadata has ${sigMeta.length} fields, expected 9`);
sigMeta.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

// 3. User transaction bodies: TransactionType < TransactionMaxUser, in type order.
const maxUser = Number(/const TransactionMaxUser TransactionMax = (\d+)/.exec(enums)[1]);
const typeNums = {};
for (const m of enums.matchAll(/const (TransactionType\w+) TransactionType = (\d+)/g)) typeNums[m[1]] = Number(m[2]);
const typeNames = {};
{
  const s = enums.slice(enums.indexOf('func (v TransactionType) String() string'));
  const body = s.slice(0, s.indexOf('\n}\n'));
  for (const m of body.matchAll(/case (TransactionType\w+):\s+return "([^"]+)"/g)) typeNames[m[1]] = m[2];
}
const newBody = unions.slice(unions.indexOf('func NewTransactionBody('));
const newBodyFn = newBody.slice(0, newBody.indexOf('\n}\n'));
const bodies = [];
for (const m of newBodyFn.matchAll(/case (TransactionType\w+):\s+return new\((\w+)\)/g)) {
  const n = typeNums[m[1]];
  if (n >= 1 && n < maxUser) bodies.push({ n, name: typeNames[m[1]], struct: m[2] });
}
bodies.sort((a, b) => a.n - b.n);
// Every TransactionType and its JSON name (accumulate-sdk-opendlt's enum lacks some, e.g. setLiteAccountDelegate).
const TRANSACTION_TYPE_NAMES = {};
for (const [k, name] of Object.entries(typeNames)) TRANSACTION_TYPE_NAMES[typeNums[k]] = name;

// 4. Union member tables (RegisterUnion in signature_eip712.go: NewKeyPageOperation, NewAccountAuthOperation, NewDataEntry).
function unionTable(newFn, enumType, prefix) {
  const i = unions.indexOf(`func ${newFn}(`);
  const fn = unions.slice(i, unions.indexOf('\n}\n', i));
  const s = enums.slice(enums.indexOf(`func (v ${enumType}) String() string`));
  const strFn = s.slice(0, s.indexOf('\n}\n'));
  const names = {};
  for (const m of strFn.matchAll(new RegExp(`case ${enumType}(\\w+):\\s+return "([^"]+)"`, 'g'))) names[m[1]] = m[2];
  const out = {};
  for (const m of fn.matchAll(new RegExp(`case ${prefix}(\\w+):\\s+return new\\((\\w+)\\)`, 'g'))) out[names[m[1]]] = m[2];
  return out;
}
const UNIONS = {
  DataEntry: unionTable('NewDataEntry', 'DataEntryType', 'DataEntryType'),
  KeyPageOperation: unionTable('NewKeyPageOperation', 'KeyPageOperationType', 'KeyPageOperationType'),
  AccountAuthOperation: unionTable('NewAccountAuthOperation', 'AccountAuthOperationType', 'AccountAuthOperationType'),
};
for (const [k, v] of Object.entries(UNIONS)) if (!Object.keys(v).length) throw new Error(`empty union ${k}`);

const lit = (v) => JSON.stringify(v);
let out = `// DO NOT EDIT. Generated by tools/gen-eip712-schema.mjs from gitlab.com/accumulatenetwork/accumulate@${COMMIT}
// (the commit Kermit runs: protocol/types_gen.go, protocol/signature_eip712.go, protocol/enums_gen.go, protocol/unions_gen.go).

/** The Accumulate commit this table was read from. */
export const SCHEMA_COMMIT = '${COMMIT}';

/** A struct's EIP-712 fields: [JSON name, EIP-712 type], sorted by name as encoding.RegisterTypeDefinition sorts them. */
export type FieldList = readonly (readonly [string, string])[];

/** schemaDictionary: every protocol struct registered with encoding.RegisterTypeDefinition. */
export const SCHEMA: Readonly<Record<string, FieldList>> = {\n`;
for (const [name, fields] of Object.entries(defs).sort((a, b) => (a[0] < b[0] ? -1 : 1))) out += `  ${lit(name)}: ${lit(fields)},\n`;
out += `};

/** Struct-valued fields (JSON name, struct): present in Go's JSON as {} even when zero. Keyed by the owning struct. */
export const VALUE_STRUCTS: Readonly<Record<string, readonly (readonly [string, string])[]>> = ${lit(VALUE_STRUCTS)};

/** Fields declared big.Int (not *big.Int): zero is the same as absent. Keyed by the owning struct. */
export const VALUE_BIGINTS: Readonly<Record<string, readonly string[]>> = ${lit(VALUE_BIGINTS)};

/** The SignatureMetadata definition protocol/signature_eip712.go registers. */
export const SIGNATURE_METADATA: FieldList = ${lit(sigMeta)};

/** The user transaction body fields of the EIP-712 Transaction: [JSON name of the body type, struct name], in TransactionType order. */
export const TRANSACTION_BODIES: readonly (readonly [string, string])[] = ${lit(bodies.map((b) => [b.name, b.struct]))};

/** TransactionType.String(): the JSON name of every transaction type value. */
export const TRANSACTION_TYPE_NAMES: Readonly<Record<number, string>> = ${lit(TRANSACTION_TYPE_NAMES)};

/** encoding.RegisterUnion tables: union name -> (enum name -> member struct). */
export const UNIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = ${lit(UNIONS)};
`;
const dest = fileURLToPath(new URL('../src/sigtypes/eip712-schema.ts', import.meta.url));
writeFileSync(dest, out);
console.log(`wrote ${dest}: ${Object.keys(defs).length} definitions, ${bodies.length} body types, unions ${Object.entries(UNIONS).map(([k, v]) => `${k}=${Object.keys(v).length}`).join(' ')}`);
