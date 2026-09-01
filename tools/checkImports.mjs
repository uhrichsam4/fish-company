#!/usr/bin/env node
/**
 * Static import check for src/.
 *
 * Two things go wrong in this codebase in a way the browser hides:
 *
 *  1. A relative import points at a file that has been moved or renamed. Vite
 *     surfaces this, but only once something actually imports the module.
 *
 *  2. An entry in main.js's `optional` system list has a bad path or a stale
 *     export name. That loop catches everything and console.warn()s, so the
 *     game boots perfectly happily with a whole system silently missing --
 *     no error, no crash, just a feature that quietly stopped existing.
 *
 * Run with `npm run lint`. Exits non-zero on any unresolved import.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const rel = (p) => relative(ROOT, p);

/** Every .js file under src/. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Blank out comments, replacing them with spaces so every byte offset (and
 * therefore every reported line number) still lines up with the real file.
 * String-aware, because this file is full of doc comments containing example
 * imports and this repo has plenty of './/'-shaped text inside string literals.
 */
function blankComments(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') out[i++] = ' ';
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      while (i < stop) { if (src[i] !== '\n') out[i] = ' '; i++; }
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
    } else {
      i++;
    }
  }
  return out.join('');
}

/**
 * Relative specifiers only -- bare ones ('three', 'three/addons/...') are the
 * package manager's problem, and Vite resolves them through node_modules.
 */
const SPEC = /(?:^|[\s;{(])(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|(?:^|[\s;{(])import\s*\(\s*['"](\.[^'"]+)['"]\s*\)|(?:^|[\s;{(])import\s*['"](\.[^'"]+)['"]/g;

/** Mirrors Vite: try the literal path, then .js, then /index.js. */
function resolveSpec(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.js`, join(base, 'index.js')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

const problems = [];
const files = walk(SRC);

for (const file of files) {
  const src = blankComments(readFileSync(file, 'utf8'));
  for (const m of src.matchAll(SPEC)) {
    const spec = m[1] || m[2] || m[3];
    if (!spec) continue;
    if (!resolveSpec(file, spec)) {
      const line = src.slice(0, m.index).split('\n').length;
      problems.push(`${rel(file)}:${line}  unresolved import '${spec}'`);
    }
  }
}

// ---- main.js's dynamically loaded system list -------------------------------
// Entries look like ['./world/EventSystem.js', 'EventSystem'].
const mainPath = join(SRC, 'main.js');
const mainSrc = blankComments(readFileSync(mainPath, 'utf8'));
let systems = 0;

for (const m of mainSrc.matchAll(/\[\s*'(\.[^']+)'\s*,\s*'([A-Za-z_$][\w$]*)'\s*\]/g)) {
  const [, spec, name] = m;
  const line = mainSrc.slice(0, m.index).split('\n').length;
  const target = resolveSpec(mainPath, spec);
  systems++;

  if (!target) {
    problems.push(`src/main.js:${line}  system '${name}' -> missing module '${spec}'`);
    continue;
  }
  const body = blankComments(readFileSync(target, 'utf8'));
  const exported =
    new RegExp(`export\\s+(?:async\\s+)?(?:class|function|const|let|var)\\s+${name}\\b`).test(body) ||
    new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(body) ||
    /export\s+default\b/.test(body);

  if (!exported) {
    problems.push(`src/main.js:${line}  '${rel(target)}' has no export "${name}" (system loads as undefined)`);
  }
}

const scanned = `${files.length} files, ${systems} dynamically loaded systems`;
if (problems.length) {
  console.error(`checkImports: ${problems.length} problem(s) across ${scanned}\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`checkImports: clean -- ${scanned}`);
