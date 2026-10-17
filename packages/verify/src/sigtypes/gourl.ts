/**
 * Accumulate's URL, as Go reads and writes it - because the binary encoding carries URLs as strings and Accumulate's reader parses
 * every one (pkg/url Parse over net/url Parse), refusing the whole object when one does not parse, and its writer emits the parsed
 * URL's String(), not the bytes it was given. A signer URL's spelling is inside the signature's metadata hash, so a verifier that
 * kept the string it was handed would hash a different spelling from the one Accumulate hashed, and would accept or refuse a
 * signature Accumulate did not.
 *
 * This is a port of the parts of Go 1.25's net/url that Parse uses (getScheme, parse, parseAuthority, parseHost, validOptionalPort,
 * validUserinfo, unescape, setPath, setFragment, shouldEscape, escape) and of accumulate's pkg/url (Parse, AsTxID, format,
 * normalizePath). Strings in this module are BINARY strings: one JS char per byte (0-255), because Go strings are byte strings and
 * a URL may carry bytes that are not UTF-8.
 */

export function binaryString(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
}

export function binaryBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * The text Go's json.Marshal produces for a Go string, as json.Unmarshal reads it back: valid UTF-8 as itself, and every byte of
 * an invalid sequence as U+FFFD (utf8.DecodeRune reports width 1 for each).
 */
export function goText(binary: string): string {
  let out = '';
  const n = binary.length;
  let i = 0;
  while (i < n) {
    const c = binary.charCodeAt(i);
    if (c < 0x80) {
      out += binary[i];
      i++;
      continue;
    }
    let need = 0;
    let min = 0;
    let cp = 0;
    if (c >= 0xc2 && c <= 0xdf) {
      need = 1;
      min = 0x80;
      cp = c & 0x1f;
    } else if (c >= 0xe0 && c <= 0xef) {
      need = 2;
      min = 0x800;
      cp = c & 0x0f;
    } else if (c >= 0xf0 && c <= 0xf4) {
      need = 3;
      min = 0x10000;
      cp = c & 0x07;
    } else {
      out += '�';
      i++;
      continue;
    }
    let ok = i + need < n; // the continuation bytes exist
    if (ok) {
      for (let k = 1; k <= need; k++) {
        const cc = binary.charCodeAt(i + k);
        if ((cc & 0xc0) !== 0x80) {
          ok = false;
          break;
        }
        cp = (cp << 6) | (cc & 0x3f);
      }
    }
    if (!ok || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      out += '�';
      i++;
      continue;
    }
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}

// ------------------------------------------------------------------ net/url

type Mode = 'host' | 'zone' | 'path' | 'pathSegment' | 'userPassword' | 'queryComponent' | 'fragment';

const isAlnum = (c: number): boolean => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39);
const ishex = (c: number): boolean => (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
const unhex = (c: number): number => (c <= 0x39 ? c - 0x30 : (c | 0x20) - 0x61 + 10);

/** net/url shouldEscape, for the byte `c`. */
function shouldEscape(c: number, mode: Mode): boolean {
  if (isAlnum(c)) return false;
  const ch = String.fromCharCode(c);
  if (mode === 'host' || mode === 'zone') {
    if ("!$&'()*+,;=:[]<>\"".includes(ch)) return false;
  }
  if ('-_.~'.includes(ch)) return false;
  if ('$&+,/:;=?@'.includes(ch)) {
    switch (mode) {
      case 'path':
        return ch === '?';
      case 'pathSegment':
        return ch === '/' || ch === ';' || ch === ',' || ch === '?';
      case 'userPassword':
        return ch === '@' || ch === '/' || ch === '?' || ch === ':';
      case 'queryComponent':
        return true;
      case 'fragment':
        return false;
    }
  }
  if (mode === 'fragment' && '!()*'.includes(ch)) return false;
  return true;
}

/** net/url unescape: undefined where Go returns an error. */
function unescape(s: string, mode: Mode): string | undefined {
  let n = 0;
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i);
    if (c === 0x25) {
      n++;
      if (i + 2 >= s.length || !ishex(s.charCodeAt(i + 1)) || !ishex(s.charCodeAt(i + 2))) return undefined;
      if (mode === 'host' && unhex(s.charCodeAt(i + 1)) < 8 && s.slice(i, i + 3) !== '%25') return undefined;
      if (mode === 'zone') {
        const v = (unhex(s.charCodeAt(i + 1)) << 4) | unhex(s.charCodeAt(i + 2));
        if (s.slice(i, i + 3) !== '%25' && v !== 0x20 && shouldEscape(v, 'host')) return undefined;
      }
      i += 3;
    } else {
      if ((mode === 'host' || mode === 'zone') && c < 0x80 && shouldEscape(c, mode)) return undefined;
      i++;
    }
  }
  if (n === 0) return s;
  let t = '';
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x25) {
      t += String.fromCharCode((unhex(s.charCodeAt(i + 1)) << 4) | unhex(s.charCodeAt(i + 2)));
      i += 2;
    } else t += s[i];
  }
  return t;
}

/** net/url escape. */
function escape(s: string, mode: Mode): string {
  let t = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    t += shouldEscape(c, mode) ? `%${c.toString(16).toUpperCase().padStart(2, '0')}` : s[i];
  }
  return t;
}

function validOptionalPort(port: string): boolean {
  if (port === '') return true;
  if (port[0] !== ':') return false;
  for (let i = 1; i < port.length; i++) if (port.charCodeAt(i) < 0x30 || port.charCodeAt(i) > 0x39) return false;
  return true;
}

/** net/url validUserinfo, over the runes of s (a byte of a multi-byte sequence is never one of the allowed ASCII characters). */
function validUserinfo(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isAlnum(c)) continue;
    if ("-._:~!$&'()*+,;=%@".includes(s[i]!)) continue;
    return false;
  }
  return true;
}

function parseHost(host: string): string | undefined {
  if (host.startsWith('[')) {
    const i = host.lastIndexOf(']');
    if (i < 0) return undefined;
    if (!validOptionalPort(host.slice(i + 1))) return undefined;
    const zone = host.slice(0, i).indexOf('%25');
    if (zone >= 0) {
      const h1 = unescape(host.slice(0, zone), 'host');
      const h2 = unescape(host.slice(zone, i), 'zone');
      const h3 = unescape(host.slice(i), 'host');
      if (h1 === undefined || h2 === undefined || h3 === undefined) return undefined;
      return h1 + h2 + h3;
    }
  } else {
    const i = host.lastIndexOf(':');
    if (i !== -1 && !validOptionalPort(host.slice(i))) return undefined;
  }
  return unescape(host, 'host');
}

interface NetUrl {
  scheme: string;
  host: string;
  user: string; // "name" or "name:password"; empty when there is none
  path: string; // decoded
  query: string; // raw
  fragment: string; // decoded
}

/** net/url Parse; undefined where Go returns an error. */
function netUrlParse(rawUrl: string): NetUrl | undefined {
  const hash = rawUrl.indexOf('#');
  const u = hash < 0 ? rawUrl : rawUrl.slice(0, hash);
  const frag = hash < 0 ? '' : rawUrl.slice(hash + 1);
  const url = parse(u);
  if (!url) return undefined;
  if (frag !== '') {
    const f = unescape(frag, 'fragment');
    if (f === undefined) return undefined;
    url.fragment = f;
  }
  return url;
}

function parse(rawUrl: string): NetUrl | undefined {
  for (let i = 0; i < rawUrl.length; i++) {
    const b = rawUrl.charCodeAt(i);
    if (b < 0x20 || b === 0x7f) return undefined; // invalid control character
  }
  const url: NetUrl = { scheme: '', host: '', user: '', path: '', query: '', fragment: '' };
  if (rawUrl === '*') {
    url.path = '*';
    return url;
  }
  // getScheme
  let rest = rawUrl;
  scheme: for (let i = 0; i < rawUrl.length; i++) {
    const c = rawUrl.charCodeAt(i);
    if ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a)) continue;
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      if (i === 0) break scheme;
      continue;
    }
    if (c === 0x3a) {
      if (i === 0) return undefined; // missing protocol scheme
      url.scheme = rawUrl.slice(0, i).toLowerCase();
      rest = rawUrl.slice(i + 1);
    }
    break;
  }
  const qmarks = rest.split('?').length - 1;
  if (rest.endsWith('?') && qmarks === 1) {
    rest = rest.slice(0, -1);
  } else {
    const q = rest.indexOf('?');
    if (q >= 0) {
      url.query = rest.slice(q + 1);
      rest = rest.slice(0, q);
    }
  }
  if (!rest.startsWith('/')) {
    if (url.scheme !== '') {
      // a rootless path is opaque: accumulate then finds no host
      return url;
    }
    const slash = rest.indexOf('/');
    const segment = slash < 0 ? rest : rest.slice(0, slash);
    if (segment.includes(':')) return undefined; // first path segment cannot contain colon
  }
  if ((url.scheme !== '' || !rest.startsWith('///')) && rest.startsWith('//')) {
    let authority = rest.slice(2);
    rest = '';
    const slash = authority.indexOf('/');
    if (slash >= 0) {
      rest = authority.slice(slash);
      authority = authority.slice(0, slash);
    }
    const at = authority.lastIndexOf('@');
    const host = parseHost(at < 0 ? authority : authority.slice(at + 1));
    if (host === undefined) return undefined;
    if (at >= 0) {
      const userinfo = authority.slice(0, at);
      if (!validUserinfo(userinfo)) return undefined;
      const colon = userinfo.indexOf(':');
      if (colon < 0) {
        const name = unescape(userinfo, 'userPassword');
        if (name === undefined) return undefined;
        url.user = name;
      } else {
        const name = unescape(userinfo.slice(0, colon), 'userPassword');
        const pass = unescape(userinfo.slice(colon + 1), 'userPassword');
        if (name === undefined || pass === undefined) return undefined;
        url.user = pass === '' ? name : `${name}:${pass}`;
      }
    }
    url.host = host;
  }
  const path = unescape(rest, 'path');
  if (path === undefined) return undefined;
  url.path = path;
  return url;
}

// ------------------------------------------------------------------ accumulate pkg/url

interface AccUrl {
  userInfo: string;
  authority: string;
  path: string;
  query: string;
  fragment: string;
}

/** accumulate url.Parse; undefined where it returns an error. */
function accParse(s: string): AccUrl | undefined {
  let u = netUrlParse(s);
  if (u && u.scheme === '') u = netUrlParse(`acc://${s}`);
  if (!u) return undefined;
  if (u.scheme !== 'acc') return undefined;
  if (u.host === '' || u.host[0] === ':') return undefined;
  return { userInfo: u.user, authority: u.host, path: u.path, query: u.query, fragment: u.fragment };
}

function trimSlashes(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === '/') a++;
  while (b > a && s[b - 1] === '/') b--;
  return s.slice(a, b);
}
const normalizePath = (s: string): string => {
  const t = trimSlashes(s);
  return t === '' ? '' : `/${t}`;
};

/** accumulate URL.format with encode=true: `txid` (hex) replaces the user info. */
function accFormat(u: AccUrl, txid?: string): string {
  let out = 'acc://';
  if (txid !== undefined) out += `${txid}@`;
  else if (u.userInfo !== '') out += `${u.userInfo}@`;
  out += u.authority;
  let p = normalizePath(u.path);
  while (p.length > 0) {
    out += '/';
    const i = p.indexOf('/', 1);
    if (i < 0) {
      out += escape(p.slice(1), 'pathSegment');
      break;
    }
    out += escape(p.slice(1, i), 'pathSegment');
    p = p.slice(i);
  }
  if (u.query !== '') out += `?${u.query}`;
  if (u.fragment !== '') out += `#${u.fragment}`;
  return out;
}

/** Parse an Accumulate URL and return its String() (the form the writer emits), or undefined where Accumulate's reader fails. */
export function canonicalAccUrl(s: string): string | undefined {
  const u = accParse(s);
  return u ? accFormat(u) : undefined;
}

/** url.ParseTxID then TxID.String(): the user info is the 32-byte transaction hash in hex. */
export function canonicalAccTxId(s: string): string | undefined {
  const u = accParse(s);
  if (!u || u.userInfo === '') return undefined;
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(u.userInfo) || u.userInfo.length !== 64) return undefined;
  return accFormat({ ...u, userInfo: '' }, u.userInfo.toLowerCase());
}
