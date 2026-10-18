/**
 * Accumulate's URL and the protocol helpers the evidence 2.1 verifier needs, as Accumulate's Go code defines them (pkg/url,
 * protocol/protocol.go), on top of the Go-faithful URL parser of the signature-type verifier (sigtypes/gourl.ts).
 *
 * A URL here is a value with the components url.URL has (user info, authority, UNESCAPED path, query, fragment); its String() is the
 * form Accumulate's writer emits. Every URL the verifier reads from a document is parsed by Accumulate's parser first, and one that does
 * not parse is a refusal, exactly as `url.Parse` returning an error is in Go.
 */
import { sha256 } from '../proof-v2/bytes.js';
import { binaryBytes, binaryString, canonicalAccUrl } from '../sigtypes/gourl.js';

/** The delegation depth limit of Accumulate (protocol.DelegationDepthLimit). */
export const DELEGATION_DEPTH_LIMIT = 20;
/** protocol.Directory, protocol.TLD and the partition URL prefix. */
export const DIRECTORY = 'Directory';
const TLD = '.acme';
const BVN_PREFIX = 'bvn-';

// --------------------------------------------------------------------------------------------------------------------------------
// strings as Go compares them

/** Go's string order: bytewise on UTF-8. */
export function goStringCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** unicode.ToLower of one code point, as Go's strings.ToLower applies it (JavaScript's full mapping differs for U+0130). */
function lowerRune(ch: string): string {
  return ch.codePointAt(0) === 0x130 ? 'i' : ch.toLowerCase();
}

/** strings.ToLower. */
export function goLower(s: string): string {
  let out = '';
  for (const ch of s) out += lowerRune(ch);
  return out;
}

/** The simple-folding class of one code point (unicode.SimpleFold's orbit, by the case mappings JavaScript has). */
function foldRune(ch: string): string {
  const up = ch.toUpperCase();
  const base = [...up].length === 1 ? up : ch;
  return lowerRune(base);
}

/** strings.EqualFold. */
export function goEqualFold(a: string, b: string): boolean {
  const x = [...a];
  const y = [...b];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i] && foldRune(x[i]!) !== foldRune(y[i]!)) return false;
  return true;
}

const utf8 = new TextDecoder('utf-8');
const fromBinary = (s: string): string => utf8.decode(binaryBytes(s));
const toBinary = (s: string): string => binaryString(new TextEncoder().encode(s));

function unescapePath(escaped: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < escaped.length; i++) {
    const c = escaped.charCodeAt(i);
    if (c === 0x25 && i + 2 < escaped.length + 0 && /^[0-9a-fA-F]{2}$/.test(escaped.slice(i + 1, i + 3))) {
      bytes.push(parseInt(escaped.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(c & 0xff);
  }
  return utf8.decode(Uint8Array.from(bytes));
}

// --------------------------------------------------------------------------------------------------------------------------------
// url.URL

export class AccUrl {
  constructor(
    readonly authority: string,
    readonly path: string = '',
    readonly userInfo: string = '',
    readonly query: string = '',
    readonly fragment: string = '',
  ) {}

  /** url.Parse: undefined where Accumulate's parser returns an error. `s` is a JavaScript string (Go reads its UTF-8 bytes). */
  static parse(s: string): AccUrl | undefined {
    return AccUrl.fromBinary(toBinary(s));
  }

  /** url.Parse of a BINARY string (one char per byte): a URL field of a decoded wire object. */
  static fromBinary(bin: string): AccUrl | undefined {
    const canon = canonicalAccUrl(bin);
    if (canon === undefined) return undefined;
    // canon is the writer's form: acc://[userinfo@]authority[/seg...][?query][#fragment]
    let rest = fromBinary(canon).slice('acc://'.length);
    let fragment = '';
    let query = '';
    const h = rest.indexOf('#');
    if (h >= 0) {
      fragment = rest.slice(h + 1);
      rest = rest.slice(0, h);
    }
    const q = rest.indexOf('?');
    if (q >= 0) {
      query = rest.slice(q + 1);
      rest = rest.slice(0, q);
    }
    let userInfo = '';
    const slash = rest.indexOf('/');
    const head = slash >= 0 ? rest.slice(0, slash) : rest;
    const at = head.lastIndexOf('@');
    if (at >= 0) {
      userInfo = head.slice(0, at);
      rest = rest.slice(at + 1);
    }
    const s2 = rest.indexOf('/');
    const authority = s2 >= 0 ? rest.slice(0, s2) : rest;
    const path = s2 >= 0 ? rest.slice(s2).split('/').map(unescapePath).join('/') : '';
    return new AccUrl(authority, path, userInfo, query, fragment);
  }

  /** url.MustParse for a string that is known to be a URL (constants). */
  static must(s: string): AccUrl {
    const u = AccUrl.parse(s);
    if (!u) throw new Error(`not a URL: ${s}`);
    return u;
  }

  /** URL.String(): the writer's form, with the path escaped per segment (url.PathEscape). */
  toString(): string {
    let out = 'acc://';
    if (this.userInfo !== '') out += `${this.userInfo}@`;
    out += this.authority;
    const trimmed = trimSlashes(this.path);
    if (trimmed !== '') {
      for (const seg of trimmed.split('/')) out += `/${pathEscape(seg)}`;
    }
    if (this.query !== '') out += `?${this.query}`;
    if (this.fragment !== '') out += `#${this.fragment}`;
    return out;
  }

  /** strings.ToLower(u.String()): the key the verifier indexes accounts by (lk in Go). */
  get key(): string {
    return goLower(this.toString());
  }

  equal(v: AccUrl | null | undefined): boolean {
    return !!v && goEqualFold(this.toString(), v.toString());
  }

  rootIdentity(): AccUrl {
    return new AccUrl(this.authority, '', this.userInfo);
  }

  isRootIdentity(): boolean {
    return this.path === '' || this.path === '/';
  }

  /** URL.Parent: the parent path, or the original URL (with its path canonicalised) and false. */
  parent(): [AccUrl, boolean] {
    let p = this.path;
    if (p.endsWith('/')) p = p.slice(0, -1);
    if (p.length === 0) return [new AccUrl(this.authority, p, this.userInfo), false];
    const i = p.lastIndexOf('/');
    return [new AccUrl(this.authority, i === -1 ? '' : p.slice(0, i), this.userInfo), true];
  }

  /** URL.Identity: Parent without the flag. */
  identity(): AccUrl {
    return this.parent()[0];
  }

  /** u.ParentOf(v): u is v's parent. */
  parentOf(v: AccUrl): boolean {
    const [p, ok] = v.parent();
    return ok && this.equal(p);
  }

  joinPath(...segments: string[]): AccUrl {
    if (segments.length === 0) return this;
    // path.Join(append([]string{path-or-"/"}, s...)...): clean, join with '/'
    const parts = [this.path === '' ? '/' : this.path, ...segments];
    return new AccUrl(this.authority, pathJoin(parts), this.userInfo, this.query, this.fragment);
  }

  hostname(): string {
    const i = this.authority.indexOf(':');
    return i < 0 ? this.authority : this.authority.slice(0, i);
  }

  /** URL.IdentityAccountID32: sha256(lower-case hostname). */
  identityAccountId(): Uint8Array {
    return sha256(new TextEncoder().encode(goLower(this.hostname())));
  }

  /** URL.Routing: the first 8 bytes of the identity account id, big endian. */
  routing(): bigint {
    return new DataView(this.identityAccountId().buffer, 0, 8).getBigUint64(0);
  }
}

function trimSlashes(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === '/') a++;
  while (b > a && s[b - 1] === '/') b--;
  return s.slice(a, b);
}

/** url.PathEscape (net/url escape in encodePathSegment mode). */
function pathEscape(seg: string): string {
  let out = '';
  for (const b of new TextEncoder().encode(seg)) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~]/.test(c) || ('$&+=:@'.includes(c))) out += c;
    else out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** path.Join: join with '/', then path.Clean. */
function pathJoin(elems: string[]): string {
  const joined = elems.filter((e) => e !== '').join('/');
  if (joined === '') return '';
  const rooted = joined.startsWith('/');
  const out: string[] = [];
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!rooted) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const body = out.join('/');
  if (rooted) return `/${body}`;
  return body === '' ? '.' : body;
}

// --------------------------------------------------------------------------------------------------------------------------------
// protocol helpers

const dnUrl = (): AccUrl => new AccUrl(`dn${TLD}`);
export const DN_URL = dnUrl();
export const ANCHOR_POOL = 'anchors';
export const SYNTHETIC = 'synthetic';
export const LEDGER = 'ledger';

/** protocol.PartitionUrl. */
export function partitionUrl(partition: string): AccUrl {
  return goEqualFold(partition, DIRECTORY) ? dnUrl() : new AccUrl(`${BVN_PREFIX}${partition}${TLD}`);
}

/** protocol.IsDnUrl. */
export function isDnUrl(u: AccUrl): boolean {
  return dnUrl().equal(u.rootIdentity());
}

/** protocol.ParsePartitionUrl: the partition id ("Directory", "BVN2") a partition ADI URL names. */
export function parsePartitionUrl(u: AccUrl): string | undefined {
  if (isDnUrl(u)) return DIRECTORY;
  const a = u.authority;
  if (!a.startsWith(BVN_PREFIX) || !a.endsWith(TLD)) return undefined;
  // Go slices a[len(prefix) : len(a)-len(tld)]; a string shorter than both is not reachable by the two checks above only when equal.
  if (a.length < BVN_PREFIX.length + TLD.length) return undefined;
  return a.slice(BVN_PREFIX.length, a.length - TLD.length);
}

/** protocol.IsUnknown. */
export function isUnknown(u: AccUrl): boolean {
  return goEqualFold(u.authority, 'unknown') || goEqualFold(u.authority, `unknown${TLD}`);
}

/** protocol.FormatKeyPageUrl. */
export function formatKeyPageUrl(book: AccUrl, pageIndex: bigint | number): AccUrl {
  return book.joinPath((BigInt(pageIndex) + 1n).toString(10));
}

/** protocol.ParseKeyPageUrl: the key book and the page number (0..65535) a key page URL names. */
export function parseKeyPageUrl(page: AccUrl): { book: AccUrl; index: number } | undefined {
  const i = page.path.lastIndexOf('/');
  if (i < 0) return undefined;
  const tail = page.path.slice(i + 1);
  if (!/^\+?[0-9]+$/.test(tail)) return undefined;
  const n = BigInt(tail.replace(/^\+/, ''));
  if (n > 0xffffn) return undefined;
  return { book: page.identity(), index: Number(n) };
}

function hexDecode(s: string): Uint8Array | undefined {
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) return undefined;
  return new Uint8Array(Buffer.from(s, 'hex'));
}

/** protocol.ParseLiteAddress: the hex hostname without its 4-byte checksum, or undefined (any error). */
function parseLiteAddress(u: AccUrl): Uint8Array | undefined {
  const b = hexDecode(u.hostname());
  if (!b || b.length <= 4) return undefined;
  const i = b.length - 4;
  const hexValue = u.authority.slice(0, u.authority.length - 8);
  const sum = sha256(new TextEncoder().encode(hexValue));
  const check = b.subarray(i);
  const want = sum.subarray(sum.length - 4);
  for (let k = 0; k < 4; k++) if (check[k] !== want[k]) return undefined;
  return b.slice(0, i);
}

/** protocol.ParseLiteIdentity, with every error as "not lite" (the verifier only asks whether the key is nil). */
export function parseLiteIdentity(u: AccUrl): Uint8Array | undefined {
  if (u.path !== '' && u.path !== '/') return undefined;
  const b = parseLiteAddress(u);
  return b && b.length === 20 ? b : undefined;
}

/** protocol.ParseLiteTokenAddress, with every error as "not lite". */
export function parseLiteTokenAddress(u: AccUrl): Uint8Array | undefined {
  if (u.path === '' || u.path.length === 1) return undefined;
  const b = parseLiteAddress(u);
  return b && b.length === 20 ? b.slice(0, 20) : undefined;
}

/** The page an initiating key signature paid from: its signer, a lite token address paying as its lite identity. */
export function payerOf(signer: AccUrl): AccUrl {
  if (!parseLiteIdentity(signer) && parseLiteTokenAddress(signer)) return signer.rootIdentity();
  return signer;
}
