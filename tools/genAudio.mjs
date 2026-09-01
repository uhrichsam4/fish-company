#!/usr/bin/env node
/**
 * Generate missing sound effects with ElevenLabs and cache them on disk.
 *
 * Run once (or after adding an entry to SOUNDS); the results are committed to
 * public/assets/audio/generated/ being gitignored, so each machine generates
 * its own copy at most once. Nothing here runs at play time -- the game only
 * ever loads the local files.
 *
 * Keys come from the environment (.env locally, the dashboard on Render) and
 * are never shipped to the browser. The backup key is tried automatically when
 * the primary is rate limited or out of credit.
 *
 *   node tools/genAudio.mjs           generate anything missing
 *   node tools/genAudio.mjs --force   regenerate everything
 *   node tools/genAudio.mjs --list    show what would be generated
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public/assets/audio/generated');
const ENDPOINT = 'https://api.elevenlabs.io/v1/sound-generation';

// ---- keys -------------------------------------------------------------------

function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const KEYS = [process.env.ELEVENLABS_API_KEY, process.env.ELEVENLABS_API_KEY_BACKUP].filter(Boolean);
if (!KEYS.length) {
  console.error('No ELEVENLABS_API_KEY set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

/**
 * Sounds the new mechanics need and the game does not already have.
 * `prompt` is what ElevenLabs is asked for; `seconds` keeps clips short so
 * they can be triggered repeatedly without overlapping into mush.
 */
const SOUNDS = [
  { id: 'bucket_set_down', seconds: 1.5, prompt: 'a metal bucket being set down on wooden planks, single soft clunk, close up, dry' },
  { id: 'bucket_pick_up', seconds: 1.2, prompt: 'a metal bucket handle rattling as it is lifted, short, close up, dry' },
  { id: 'bucket_carry', seconds: 2.0, prompt: 'a metal bucket handle creaking and sloshing gently while carried, soft, looping' },
  { id: 'fish_into_bucket', seconds: 1.5, prompt: 'a wet fish dropped into a metal bucket with shallow water, wet slap and light metallic ring' },
  { id: 'fish_flop_bucket', seconds: 2.0, prompt: 'a live fish flopping and thudding against the inside of a metal bucket, wet, close up' },
  { id: 'spear_thrust', seconds: 1.2, prompt: 'a wooden spear thrust quickly through air, sharp whoosh, close up' },
  { id: 'spear_fish_hit', seconds: 1.2, prompt: 'a dull wet impact into a fish, muffled thud, not gory, close up' },
  { id: 'bucket_sell', seconds: 2.0, prompt: 'a bucket of fish being tipped out onto a market counter, wet slithering pile' },
];

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const LIST = args.includes('--list');

async function generate(sound, key) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: sound.prompt, duration_seconds: sound.seconds }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status}: ${body.slice(0, 160)}`);
    // 401/402/429 mean "try the other key"; anything else is the prompt's fault.
    err.tryNextKey = [401, 402, 429].includes(res.status);
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const todo = SOUNDS.filter((s) => FORCE || !existsSync(path.join(OUT, `${s.id}.mp3`)));

  if (LIST) {
    console.log(`${todo.length} of ${SOUNDS.length} would be generated:`);
    for (const s of todo) console.log('  -', s.id);
    return;
  }
  if (!todo.length) { console.log(`All ${SOUNDS.length} sounds already cached in ${path.relative(ROOT, OUT)}/`); return; }

  console.log(`Generating ${todo.length} sound(s) into ${path.relative(ROOT, OUT)}/`);
  let ok = 0, failed = 0;
  for (const s of todo) {
    let saved = false;
    for (let k = 0; k < KEYS.length && !saved; k++) {
      try {
        const buf = await generate(s, KEYS[k]);
        writeFileSync(path.join(OUT, `${s.id}.mp3`), buf);
        console.log(`  ok   ${s.id.padEnd(20)} ${(buf.length / 1024).toFixed(0)} KB${k ? '  (backup key)' : ''}`);
        ok++; saved = true;
      } catch (e) {
        if (e.tryNextKey && k < KEYS.length - 1) { console.log(`  ..   ${s.id}: ${e.message.slice(0, 60)} — trying backup key`); continue; }
        console.error(`  FAIL ${s.id}: ${e.message}`);
        failed++;
        break;
      }
    }
  }
  console.log(`\n${ok} generated, ${failed} failed.`);
  if (ok) {
    const total = SOUNDS.reduce((n, s) => n + (existsSync(path.join(OUT, `${s.id}.mp3`)) ? statSync(path.join(OUT, `${s.id}.mp3`)).size : 0), 0);
    console.log(`Cache is ${(total / 1024).toFixed(0)} KB across ${SOUNDS.length} clips.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
