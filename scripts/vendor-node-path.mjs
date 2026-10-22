// SPDX-License-Identifier: Apache-2.0
// Regenerates packages/node-compat/src/vendor/node-path.ts from Node's own
// lib/path.js at the pinned release, checked against a pinned SHA-256. Usage:
//   node scripts/vendor-node-path.mjs
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const VERSION = 'v24.11.0';
const SHA256 = 'dd326ecdc2d6ad2025c4991f4b480d76a9f1d52b7f6d0988a5dc0a1d02de5209';
const URL_ = `https://raw.githubusercontent.com/nodejs/node/${VERSION}/lib/path.js`;
const OUT = new URL('../packages/node-compat/src/vendor/node-path.ts', import.meta.url).pathname;

const res = await globalThis.fetch(URL_);
if (!res.ok) throw new Error(`fetching ${URL_}: HTTP ${res.status}`);
const source = await res.text();
const digest = createHash('sha256').update(source).digest('hex');
if (digest !== SHA256) throw new Error(`lib/path.js hash mismatch: ${digest}`);

const body = [
  '// SPDX-License-Identifier: MIT',
  `// Vendored from Node.js ${VERSION} lib/path.js (sha256 ${SHA256})`,
  '// by scripts/vendor-node-path.mjs. Do not edit by hand. Copyright Node.js contributors.',
  '// @ts-nocheck',
  '/* eslint-disable */',
  '',
  '/** Runs lib/path.js with the internals it needs; returns its `module.exports`. */',
  'export function createNodePath(primordials, require, process) {',
  '  const module = { exports: {} };',
  source.replace(/^/gm, '  ').replace(/^\s+$/gm, ''),
  '  return module.exports;',
  '}',
  '',
].join('\n');
writeFileSync(OUT, body);
console.log(`wrote ${OUT}`);
