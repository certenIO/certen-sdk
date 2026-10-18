// Merges the XTS_SHARD=i/n outputs of `xtsgen pathspell` (bytes-cases-pathspell-<i>.json.gz in <dir>) into bytes-cases-pathspell.json.gz:
// the cases ordered by id, the Skipped counts added, and the bases and their base expectations required to be identical in every shard.
//   node merge-pathspell.mjs <dir>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
const dir = process.argv[2];
const parts = readdirSync(dir).filter((n) => /^bytes-cases-pathspell-\d+\.json\.gz$/.test(n)).sort();
if (parts.length === 0) throw new Error('no shard files in ' + dir);
let out;
for (const n of parts) {
  const f = JSON.parse(gunzipSync(readFileSync(`${dir}/${n}`)).toString('utf8'));
  if (!out) { out = f; continue; }
  if (JSON.stringify(f.bases) !== JSON.stringify(out.bases) || JSON.stringify(f.baseExpect) !== JSON.stringify(out.baseExpect)) throw new Error(`${n}: bases differ`);
  out.cases.push(...f.cases);
  out.skipped.panics += f.skipped.panics;
  out.skipped.flaky += f.skipped.flaky;
}
out.cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
writeFileSync(`${dir}/bytes-cases-pathspell.json.gz`, gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 }));
console.log(`${parts.length} shards, ${out.cases.length} cases, skipped ${JSON.stringify(out.skipped)}`);
