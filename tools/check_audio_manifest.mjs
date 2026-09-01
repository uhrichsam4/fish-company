#!/usr/bin/env node
/**
 * Verifies that every file referenced by src/data/audioManifest.js
 * actually exists in public/assets/audio/, expanding multi-variant
 * entries (variants + ext) the same way AudioManager.preload() does.
 * Also flags any files sitting in public/assets/audio/ that the
 * manifest never references (orphans -- not an error, just informational).
 *
 * Usage: node tools/check_audio_manifest.mjs
 * Exit code: 0 if every referenced file exists, 1 otherwise.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = join(ROOT, 'public');
const AUDIO_DIR = join(PUBLIC_DIR, 'assets/audio');

const { AUDIO_MANIFEST } = await import(join(ROOT, 'src/data/audioManifest.js'));

let checked = 0;
let missing = [];
let ok = [];
const referenced = new Set();

for (const group of ['sfx', 'loops', 'ambience', 'music']) {
  const entries = AUDIO_MANIFEST[group] || {};
  for (const [name, entry] of Object.entries(entries)) {
    const variants = entry.variants || 1;
    for (let i = 0; i < variants; i++) {
      const relUrl = variants > 1 ? `${entry.url}${i + 1}${entry.ext || '.ogg'}` : entry.url;
      const label = variants > 1 ? `${group}.${name}${i + 1}` : `${group}.${name}`;
      const abs = join(PUBLIC_DIR, relUrl);
      checked++;
      referenced.add(resolve(abs));
      if (existsSync(abs) && statSync(abs).isFile()) {
        ok.push({ label, relUrl, size: statSync(abs).size });
      } else {
        missing.push({ label, relUrl, abs });
      }
    }
  }
}

console.log(`Checked ${checked} files referenced by AUDIO_MANIFEST (${Object.keys(AUDIO_MANIFEST).join(', ')})\n`);

if (missing.length) {
  console.log(`MISSING (${missing.length}):`);
  for (const m of missing) console.log(`  [${m.label}] ${m.relUrl}`);
  console.log();
} else {
  console.log('All manifest-referenced files are present on disk.\n');
}

// Orphan check: files on disk that nothing in the manifest points to.
let orphans = [];
if (existsSync(AUDIO_DIR)) {
  for (const f of readdirSync(AUDIO_DIR)) {
    if (f === 'CREDITS.md') continue;
    const abs = resolve(join(AUDIO_DIR, f));
    if (statSync(abs).isFile() && !referenced.has(abs)) orphans.push(f);
  }
}
if (orphans.length) {
  console.log(`Orphan files in public/assets/audio/ not referenced by the manifest (${orphans.length}):`);
  for (const o of orphans) console.log(`  ${o}`);
  console.log();
}

const totalBytes = ok.reduce((s, o) => s + o.size, 0);
const sfxCount = Object.entries(AUDIO_MANIFEST.sfx || {}).length;
const loopCount = Object.entries(AUDIO_MANIFEST.loops || {}).length;
const ambCount = Object.entries(AUDIO_MANIFEST.ambience || {}).length;
const musicCount = Object.entries(AUDIO_MANIFEST.music || {}).length;

console.log('Summary');
console.log('-------');
console.log(`  manifest entries: sfx=${sfxCount} loops=${loopCount} ambience=${ambCount} music=${musicCount}`);
console.log(`  resolved files:   ${checked} (present: ${ok.length}, missing: ${missing.length})`);
console.log(`  total size:       ${(totalBytes / (1024 * 1024)).toFixed(2)} MB`);

process.exit(missing.length ? 1 : 0);
