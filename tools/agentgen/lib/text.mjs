/**
 * Generated artifacts are compared as text, not as bytes: a checkout that rewrote line endings (git autocrlf on Windows) holds
 * the same content as the generator wrote, and reporting it STALE sends people to regenerate files that are not wrong.
 */
export const normalizeEol = (s) => s.replace(/\r\n/g, '\n');
export const sameText = (a, b) => a !== null && b !== null && normalizeEol(a) === normalizeEol(b);
