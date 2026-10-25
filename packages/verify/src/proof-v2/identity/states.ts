// The closed vocabularies (vocab.json) and the named-state registry (states.json) of the S8 verifier: the twin of pkg/contractidentity
// vocab.go and states.go. `newState` builds a state only if its (code, row) is in the registry, its fields are exactly the row's
// fields, and every bound field is inside its closed vocabulary; a violation is a thrown Error (a programming defect), never a state.
import { canonical, type CanonValue } from './canon.js';
import { STATES_JSON, VOCAB_JSON } from './embedded.js';
import * as N from './names.js';

export const Prefix = 'contract_identity_';

interface VocabSet {
  title?: string;
  values?: string[];
  patterns?: string[];
  free?: string;
  numbers?: Record<string, number>;
}

export class Vocabulary {
  readonly sets: Record<string, VocabSet>;
  readonly bindings: Record<string, string>;
  private readonly member = new Map<string, Set<string>>();
  private readonly compiled = new Map<string, RegExp[]>();

  constructor(raw: string) {
    const v = JSON.parse(raw) as { format: string; sets: Record<string, VocabSet>; bindings: Record<string, string> };
    if (v.format !== 'certen-contract-identity-vocab/1') throw new Error(`contractidentity: vocab.json: format ${v.format}`);
    this.sets = v.sets;
    this.bindings = v.bindings;
    for (const [id, s] of Object.entries(this.sets)) {
      const m = new Set<string>();
      for (const x of s.values ?? []) {
        if (m.has(x)) throw new Error(`contractidentity: vocab.json: set ${id} repeats ${x}`);
        m.add(x);
      }
      this.member.set(id, m);
      this.compiled.set(id, (s.patterns ?? []).map((p) => new RegExp(p)));
      if (m.size === 0 && (s.patterns ?? []).length === 0 && !s.free) throw new Error(`contractidentity: vocab.json: set ${id} is empty`);
    }
    for (const [k, id] of Object.entries(this.bindings)) if (!this.sets[id]) throw new Error(`contractidentity: vocab.json: binding ${k} names the missing set ${id}`);
  }

  check(name: string, value: string): boolean {
    const s = this.sets[name];
    if (!s) return false;
    if (s.free) return value !== '';
    if (this.member.get(name)!.has(value)) return true;
    return this.compiled.get(name)!.some((re) => re.test(value));
  }

  setFor(code: string, field: string, row: string): string {
    const c = code.startsWith(Prefix) ? code.slice(Prefix.length) : code;
    if (row !== '') {
      const id = this.bindings[`${c}.${field}@${row}`];
      if (id !== undefined) return id;
    }
    return this.bindings[`${c}.${field}`] ?? '';
  }
}

interface Row {
  code: string;
  row: string;
  part: string;
  reason: string;
  class: string;
  fields: string[];
  optional?: string[];
  reason_set?: string;
  variants?: Record<string, string[]>;
}

export class StateError extends Error {
  readonly reason: string;
  constructor(readonly code: string, readonly fields: Record<string, CanonValue>) {
    super(code);
    const r = fields['reason'];
    this.reason = typeof r === 'string' ? r : '';
  }
  /** The canonical form of a state: {code, fields}. */
  canonical(): string {
    return canonical({ code: this.code, fields: this.fields as { [k: string]: CanonValue } });
  }
  describe(): string {
    return `${this.code}${canonical(this.fields as { [k: string]: CanonValue })}`;
  }
}

export class Registry {
  readonly rows: Row[];
  private readonly index = new Map<string, Row>();

  constructor(raw: string, readonly vocab: Vocabulary) {
    const g = JSON.parse(raw) as { format: string; prefix: string; rows: Row[] };
    if (g.format !== 'certen-contract-identity-states/1' || g.prefix !== Prefix) throw new Error('contractidentity: states.json: format or prefix');
    this.rows = g.rows;
    for (const r of this.rows) {
      const k = `${r.code}|${r.row}`;
      if (this.index.has(k)) throw new Error(`contractidentity: states.json: duplicate row ${k}`);
      this.index.set(k, r);
    }
  }

  lookup(code: string, row: string): Row | undefined {
    return this.index.get(`${code}|${row === '' ? '-' : row}`);
  }

  /** Builds a state of the row (code, row cell); `row` is "" for the cell "-". Mirrors Registry.New. */
  newState(code: string, row: string, input: Record<string, CanonValue>): StateError {
    const rr = this.lookup(code, row);
    if (!rr) throw new Error(`contractidentity: unregistered state ${code} (row "${row}")`);
    const f: Record<string, CanonValue> = { ...input };
    const fix = (k: string, want: string): void => {
      if (k in f) {
        if (f[k] !== want) throw new Error(`contractidentity: state ${code}|${rr.row}: field ${k} is ${String(f[k])}, the row fixes "${want}"`);
      } else f[k] = want;
    };
    if (rr.part !== '') fix('part', rr.part);
    const rs = rr.reason_set ?? '';
    if (rr.reason !== '' && rs === '') fix('reason', rr.reason);
    const optional = new Set(rr.optional ?? []);
    const required = new Set<string>();
    let allowed = new Set(rr.fields);
    if (rs !== '') {
      const rv = f['reason'];
      if (rv === undefined) throw new Error(`contractidentity: state ${code}|${rr.row}: the reason is required (a member of ${rs})`);
      if (typeof rv !== 'string' || !this.vocab.check(rs, rv)) throw new Error(`contractidentity: state ${code}|${rr.row}: reason ${String(rv)} is not in ${rs}`);
      const extra = rr.variants?.[rv];
      if (rr.variants && extra === undefined) throw new Error(`contractidentity: state ${code}|${rr.row}: reason ${rv} has no field variant`);
      allowed = new Set(['reason']);
      required.add('reason');
      for (const x of rr.fields) if (!optional.has(x)) (required.add(x), allowed.add(x));
      for (const x of extra ?? []) (required.add(x), allowed.add(x));
    } else {
      for (const x of rr.fields) if (!optional.has(x)) required.add(x);
    }
    for (const k of Object.keys(f)) if (!allowed.has(k)) throw new Error(`contractidentity: state ${code}|${rr.row}: field "${k}" is not a field of the row`);
    const missing = [...required].filter((k) => !(k in f)).sort();
    if (missing.length > 0) throw new Error(`contractidentity: state ${code}|${rr.row}: missing field(s) ${missing.join(',')}`);
    const short = code.slice(Prefix.length);
    for (const [k, v] of Object.entries(f)) {
      const id = this.vocab.setFor(short, k, rr.row);
      if (id === '') continue;
      if (typeof v !== 'string' || !this.vocab.check(id, v)) throw new Error(`contractidentity: state ${code}|${rr.row}: field ${k} = ${String(v)} is outside the closed vocabulary ${id}`);
    }
    canonical(f as { [k: string]: CanonValue });
    return new StateError(code, f);
  }
}

/** Registry.Validate: the state must be a state of a registry row, with exactly that row's fields and vocabulary values. Throws an Error otherwise. */
export function validateState(st: StateError): void {
  const reg = defaultRegistry();
  const rows = reg.rows.filter((r) => r.code === st.code);
  if (rows.length === 0) throw new Error('contractidentity: unregistered code ' + st.code);
  const reason = typeof st.fields['reason'] === 'string' ? (st.fields['reason'] as string) : '';
  const part = typeof st.fields['part'] === 'string' ? (st.fields['part'] as string) : '';
  let pick: Row | undefined;
  for (const r of rows) {
    if (rows.length === 1) pick = r;
    else if ((r.reason_set ?? '') !== '') { if (reason !== '' && reg.vocab.check(r.reason_set!, reason)) pick = r; } else if (r.part !== '') { if (reason === r.reason && part === r.part) pick = r; } else if (r.reason !== '') { if (reason === r.reason) pick = r; } else if (r.row === '(wrapper)') { if (!('reason' in st.fields)) pick = r; }
    if (pick) break;
  }
  if (!pick) throw new Error('contractidentity: state ' + st.code + '(reason "' + reason + '", part "' + part + '") matches no registry row');
  reg.newState(st.code, pick.row, st.fields);
}

let defaults: { vocab: Vocabulary; registry: Registry } | undefined;
export function defaultRegistry(): Registry {
  if (!defaults) {
    const vocab = new Vocabulary(VOCAB_JSON);
    defaults = { vocab, registry: new Registry(STATES_JSON, vocab) };
  }
  return defaults.registry;
}
export const defaultVocabulary = (): Vocabulary => (defaultRegistry(), defaults!.vocab);

export const must = (code: string, row: string, fields: Record<string, CanonValue>): StateError => defaultRegistry().newState(code, row, fields);

const nz = (n: number): bigint => BigInt(n < 0 ? 0 : n);
/** evidence_malformed{part, index, reason, got_len, want_len}: every number that does not apply is 0. */
export const malformed = (part: string, reason: string, index: number, gotLen: number, wantLen: number): StateError =>
  must(N.CodeEvidenceMalformed, '', { part, index: nz(index), reason, got_len: nz(gotLen), want_len: nz(wantLen) });
export const tooLarge = (part: string, count: bigint | number, limit: bigint | number): StateError =>
  must(N.CodeEvidenceTooLarge, '', { part, count: BigInt(count), limit: BigInt(limit) });
