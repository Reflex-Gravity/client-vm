// SPDX-License-Identifier: Apache-2.0
// Regenerates packages/node-compat/src/vendor/node-punycode.ts from Node's own
// lib/punycode.js (punycode.js by Mathias Bynens, MIT) at the pinned release,
// checked against a pinned SHA-256. Usage:
//   node scripts/vendor-node-punycode.mjs
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const VERSION = 'v24.11.0';
const SHA256 = 'b2ad20a51daae88344c381df3f0b1a84b102b0ce723e89f45362f5e3758bec74';
const URL_ = `https://raw.githubusercontent.com/nodejs/node/${VERSION}/lib/punycode.js`;
const OUT = new URL('../packages/node-compat/src/vendor/node-punycode.ts', import.meta.url)
  .pathname;

const res = await globalThis.fetch(URL_);
if (!res.ok) throw new Error(`fetching ${URL_}: HTTP ${res.status}`);
const source = await res.text();
const digest = createHash('sha256').update(source).digest('hex');
if (digest !== SHA256) throw new Error(`lib/punycode.js hash mismatch: ${digest}`);

const body = [
  '// SPDX-License-Identifier: MIT',
  `// Vendored from Node.js ${VERSION} lib/punycode.js (sha256 ${SHA256})`,
  '// by scripts/vendor-node-punycode.mjs. Do not edit by hand.',
  '// punycode.js: Copyright Mathias Bynens <https://mathiasbynens.be/>, MIT License.',
  '// @ts-nocheck',
  '/* eslint-disable */',
  '',
  '/** Runs lib/punycode.js with the internals it needs; returns its `module.exports`. */',
  'export function createNodePunycode(internalBinding, process) {',
  '  const module = { exports: {} };',
  source.replace(/^/gm, '  ').replace(/^\s+$/gm, ''),
  '  return module.exports;',
  '}',
  '',
].join('\n');
writeFileSync(OUT, body);
console.log(`wrote ${OUT}`);
