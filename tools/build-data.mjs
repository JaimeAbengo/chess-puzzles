// Converts the Lichess puzzle CSV into small gzip'd chunk files grouped by rating.
// Usage: node build-data.mjs <lichess_db_puzzle.csv | -> <outDir>
// (pipe `zstd -dc lichess_db_puzzle.csv.zst` into it with "-")
//
// Output:
//   outDir/manifest.json
//   outDir/bNN/C.bin   gzip'd text, one puzzle per line:
//                      id \t fen(without move counters) \t uci moves (space sep) \t rating \t theme indexes (base36, '.' sep)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';

const [, , input, outDir] = process.argv;
if (!input || !outDir) { console.error('usage: build-data.mjs <csv|-> <outDir>'); process.exit(1); }

const BASE = 400, WIDTH = 50, BUCKETS = 58;   // 400..3300
const CHUNK = 2000;
const MIN_POPULARITY = -50;
const RARE = 150000;                          // themes with fewer puzzles also get their own files
const TBASE = 400, TWIDTH = 100, TBUCKETS = 29;
const tbucketOf = r => Math.max(0, Math.min(TBUCKETS - 1, Math.floor((r - TBASE) / TWIDTH)));                     // drop puzzles Lichess players voted as clearly bad
const bucketOf = r => Math.max(0, Math.min(BUCKETS - 1, Math.floor((r - BASE) / WIDTH)));

const themeIdx = new Map(); const themeNames = []; const themeCounts = [];
const buckets = Array.from({ length: BUCKETS }, () => []);
let total = 0, dropped = 0, header = true;
const all = [];

const rl = readline.createInterface({
  input: input === '-' ? process.stdin : fs.createReadStream(input), crlfDelay: Infinity,
});
for await (const line of rl) {
  if (header) { header = false; if (line.startsWith('PuzzleId')) continue; }
  if (!line) continue;
  // PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
  const f = line.split(',');
  const pop = +f[5];
  if (pop < MIN_POPULARITY) { dropped++; continue; }
  const fen = f[1].split(' ').slice(0, 4).join(' ');
  const rating = +f[3];
  const th = f[7] ? f[7].split(' ').filter(Boolean) : [];
  const idxs = th.map(t => {
    let i = themeIdx.get(t);
    if (i === undefined) { i = themeNames.length; themeIdx.set(t, i); themeNames.push(t); themeCounts.push(0); }
    themeCounts[i]++;
    return i.toString(36);
  });
  const rec = `${f[0]}\t${fen}\t${f[2]}\t${rating}\t${idxs.join('.')}`;
  buckets[bucketOf(rating)].push(rec);
  all.push(rec);
  total++;
  if (total % 500000 === 0) console.error(`read ${total.toLocaleString()}`);
}

// deterministic shuffle so chunks mix themes/lengths
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const chunkCounts = []; let bytes = 0;
buckets.forEach((arr, b) => {
  const r = rng(b + 1);
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  const n = Math.ceil(arr.length / CHUNK);
  chunkCounts.push(n);
  if (!n) return;
  const dir = path.join(outDir, 'b' + String(b).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  for (let c = 0; c < n; c++) {
    const gz = zlib.gzipSync(arr.slice(c * CHUNK, (c + 1) * CHUNK).join('\n'), { level: 9 });
    fs.writeFileSync(path.join(dir, `${c}.bin`), gz);
    bytes += gz.length;
  }
});

// rare-theme files
const themeChunks = {};
const rareSet = new Set(themeNames.filter((t, i) => themeCounts[i] < RARE));
const tb = {}; for (const t of rareSet) tb[t] = Array.from({ length: TBUCKETS }, () => []);
const rareIdx = new Map([...rareSet].map(t => [themeIdx.get(t).toString(36), t]));
for (const rec of all) {
  const f = rec.split('\t');
  for (const x of f[4].split('.')) { const t = rareIdx.get(x); if (t) tb[t][tbucketOf(+f[3])].push(rec); }
}
for (const t of rareSet) {
  themeChunks[t] = tb[t].map((arr, b) => {
    const r = rng(b + 1000);
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    const n = Math.ceil(arr.length / CHUNK);
    if (n) fs.mkdirSync(path.join(outDir, 't', t, String(b).padStart(2, '0')), { recursive: true });
    for (let c = 0; c < n; c++) {
      const gz = zlib.gzipSync(arr.slice(c * CHUNK, (c + 1) * CHUNK).join('\n'), { level: 9 });
      fs.writeFileSync(path.join(outDir, 't', t, String(b).padStart(2, '0'), `${c}.bin`), gz);
      bytes += gz.length;
    }
    return n;
  });
}

const manifest = {
  version: Date.now().toString(36), total, dropped, base: BASE, width: WIDTH, chunkSize: CHUNK,
  chunks: chunkCounts, bytes, themes: themeNames, themeCounts,
  tbase: TBASE, twidth: TWIDTH, themeChunks,
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest));
console.error(`done: ${total.toLocaleString()} puzzles (${dropped.toLocaleString()} dropped), ${chunkCounts.reduce((a, b) => a + b, 0)} chunks, ${(bytes / 1e6).toFixed(1)} MB`);
