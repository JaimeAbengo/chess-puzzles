// Builds docs/app.js and docs/sw.js with a fresh version stamp.
import { build } from 'esbuild';
import fs from 'node:fs';
const d = new Date();
const version = `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}-${d.getHours()}${String(d.getMinutes()).padStart(2, '0')}`;
await build({ entryPoints: ['src/app.js'], bundle: true, minify: true, format: 'iife', target: ['safari16'], outfile: 'docs/app.js', define: {} });
for (const f of ['docs/app.js']) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll('__VERSION__', version));
fs.writeFileSync('docs/sw.js', fs.readFileSync('src/sw.js', 'utf8').replaceAll('__VERSION__', version));
console.log('built', version, (fs.statSync('docs/app.js').size / 1024).toFixed(0) + ' KB');
