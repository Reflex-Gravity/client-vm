// SPDX-License-Identifier: Apache-2.0
// The ESM lexer vs es-module-lexer over a corpus of real package files from this
// repo's node_modules. (CommonJS export names come from cjs-module-lexer itself,
// the library Node uses; see docs/decisions/0009.)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeEsm, stringValue } from '@clientvm/node-compat';
import * as esLexer from 'es-module-lexer';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../node_modules/.pnpm');
const MAX_FILES = Number(process.env['LEXER_CORPUS'] ?? 1500);
const MAX_BYTES = 400_000;

function collect(
  filter: (file: string, text: string) => boolean,
): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    if (out.length >= MAX_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= MAX_FILES) return;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (/\.(c|m)?js$/.test(name) && st.size < MAX_BYTES) {
        const text = readFileSync(p, 'utf8');
        if (filter(p, text)) out.push({ file: p.slice(ROOT.length), text });
      }
    }
  };
  walk(ROOT);
  return out;
}

beforeAll(async () => {
  await esLexer.init;
});

describe('ESM import detection vs es-module-lexer', () => {
  it('matches on real package files', () => {
    const files = collect(
      (f, t) => (f.endsWith('.mjs') || /^\s*(import|export)\s/m.test(t)) && !f.endsWith('.cjs'),
    );
    expect(files.length).toBeGreaterThan(100);
    const mismatches: string[] = [];
    for (const { file, text } of files) {
      let ref: ReturnType<typeof esLexer.parse>;
      try {
        ref = esLexer.parse(text);
      } catch {
        continue;
      }
      // es-module-lexer 3.x: { type: 'static' | 'reexport-star' | 'dynamic' | 'import-meta', specifier }.
      const imports = ref[0] as unknown as { type: string; specifier: string | null }[];
      const refStatic = imports
        .filter((x) => x.type !== 'dynamic' && x.type !== 'import-meta')
        .map((x) => x.specifier)
        .join(',');
      const refDynamic = imports.filter((x) => x.type === 'dynamic').length;
      const refMeta = imports.filter((x) => x.type === 'import-meta').length;
      const ours = analyzeEsm(text);
      const ourStatic = ours.imports.map((x) => stringValue(x.specifier)).join(',');
      if (
        refStatic !== ourStatic ||
        refDynamic !== ours.dynamicImports.length ||
        refMeta !== ours.importMetas.length
      ) {
        mismatches.push(
          `${file}\n  static  ref: ${refStatic}\n          us : ${ourStatic}\n  dynamic ref: ${refDynamic} us: ${ours.dynamicImports.length}; meta ref: ${refMeta} us: ${ours.importMetas.length}`,
        );
      }
    }
    console.log(`esm: ${files.length} files, ${mismatches.length} mismatches`);
    expect(mismatches.slice(0, 15).join('\n')).toBe('');
  });
});
