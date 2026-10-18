/**
 * What json.Unmarshal does with an object that repeats a key, or spells two keys alike under case folding: it decodes every occurrence in
 * document order into the same field, so a wrongly typed one is an error even when a later one is right, a null leaves a string, a number or a
 * struct as it was (and clears a slice, a map or a pointer), and two objects for one struct merge. A plain tree cannot say any of that;
 * the trees gotree.ts builds carry the pairs of an object that repeats a key (PAIRS), and the readers of this directory take the occurrences
 * of a member with the functions here.
 */
import { foldEqual } from './fold.js';

/** A number literal no reader of this port accepts (not a whole number, or beyond what a double holds exactly). */
export class BadNum {
  constructor(readonly text: string) {}
  toString(): string {
    return this.text;
  }
}

/** The ordered [key, value] pairs of an object that repeats a key (exact spelling). */
export const PAIRS: unique symbol = Symbol('goPairs');

/** Two or more occurrences of one member, in document order. */
export class Occ {
  constructor(readonly vals: unknown[]) {}
}

export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof BadNum) && !(v instanceof Occ);

/** The pairs of an object in document order. */
export function pairsOf(o: object): [string, unknown][] {
  return (o as { [PAIRS]?: [string, unknown][] })[PAIRS] ?? Object.entries(o);
}

/** The pairs a (possibly repeated) object member contributes to its struct: null is a no-op, the objects' pairs follow one another. */
export function mergedPairs(v: unknown): [string, unknown][] | undefined {
  if (v instanceof Occ) {
    const out: [string, unknown][] = [];
    for (const x of v.vals) {
      if (x === null || x === undefined) continue;
      if (!isObject(x)) return undefined;
      out.push(...pairsOf(x));
    }
    return out;
  }
  if (v === null || v === undefined) return [];
  return isObject(v) ? pairsOf(v) : undefined;
}

/**
 * The values of the pairs whose key matches `name` as Go matches a key to a field: the exact name, else the same name under case folding. Absent: an
 * empty list.
 */
export function occurrences(pairs: [string, unknown][], name: string): unknown[] {
  const out: unknown[] = [];
  for (const [k, v] of pairs) if (k === name || foldEqual(k, name)) out.push(v);
  return out;
}

/** One value for the occurrences: undefined (none), the value, or the Occ of them. */
export function oneOf(vals: unknown[]): unknown {
  return vals.length === 0 ? undefined : vals.length === 1 ? vals[0] : new Occ(vals);
}

/**
 * A text that tells two decoded trees apart exactly: every key in document order (repeats and case variants included), every number by its
 * literal (a BadNum by its text, -0 apart from 0), every string as JSON writes it. JSON.stringify of a tree is not that - it forgets a
 * repeated key's earlier value and spells -0 as 0 - so a cache keyed on it would hand one document the verdict of another.
 */
export function exactKey(v: unknown): string {
  if (v === null) return 'n';
  if (v === undefined) return 'u';
  if (v instanceof BadNum) return 'N' + v.text + ';';
  if (v instanceof Occ) return 'O[' + v.vals.map(exactKey).join(',') + ']';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (Array.isArray(v)) return '[' + v.map(exactKey).join(',') + ']';
  return '{' + pairsOf(v as object).map(([k, x]) => JSON.stringify(k) + ':' + exactKey(x)).join(',') + '}';
}
