// Copies the code shared with the web app (sibling repository ../web) into
// src/shared: the setlist/media/history helpers, so both apps read and write the
// same data in the same way. The Firebase config comes from .env instead.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const web = resolve(process.argv[2] || '../web');
const files = [
  ['src/lib/setlists.js', 'setlists.js'],
  ['src/lib/media.js', 'media.js'],
  ['src/lib/music.js', 'music.js'],
  ['src/lib/history.js', 'history.js'],
  ['src/lib/prompter.js', 'prompter.js'],
  ['src/lib/songs.js', 'songs.js'],
  ['src/lib/score.js', 'score.js'],
];
// Imports of web modules that live elsewhere here.
const REWRITES = [["from './firebase'", "from '../lib/firebase'"]];
if (!existsSync(web)) {
  console.error(`Repository web non trovato in ${web}`);
  process.exit(1);
}
for (const [from, to] of files) {
  let code = readFileSync(resolve(web, from), 'utf8');
  REWRITES.forEach(([a, b]) => (code = code.replaceAll(a, b)));
  writeFileSync(resolve('src/shared', to), code);
  console.log(`${from} → src/shared/${to}`);
}
