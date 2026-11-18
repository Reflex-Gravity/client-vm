// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { highlight, langOf } from './highlight.ts';

const strip = (html: string) =>
  html
    .replace(/<span class="tk-\w+">|<\/span>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

describe('highlight', () => {
  it('keeps the text exactly, so the overlay lines up with the textarea', () => {
    const code = 'import x from \'y\';\n// hi <b>\nconst a = `${1 & 2}` + "q";\n<App />\n';
    for (const lang of ['js', 'json', 'css', 'html', 'text'] as const) {
      expect(strip(highlight(code, lang))).toBe(code);
    }
  });

  it('escapes markup from the file', () => {
    const html = highlight('<img src=x onerror="alert(1)">', 'text');
    expect(html).not.toContain('<img');
    expect(highlight('"<script>"', 'js')).toBe(
      '<span class="tk-str">&quot;&lt;script&gt;&quot;</span>',
    );
  });

  it('marks keywords, strings, comments and JSX tags in scripts', () => {
    const html = highlight("const a = 'x'; // note\n<main>", 'js');
    expect(html).toContain('<span class="tk-kw">const</span>');
    expect(html).toContain(`<span class="tk-str">'x'</span>`);
    expect(html).toContain('<span class="tk-com">// note</span>');
    expect(html).toContain('<span class="tk-tag">&lt;main</span>');
  });

  it('tells JSON keys from values', () => {
    const html = highlight('{ "name": "app", "private": true }', 'json');
    expect(html).toContain('<span class="tk-key">&quot;name&quot;</span>');
    expect(html).toContain('<span class="tk-str">&quot;app&quot;</span>');
    expect(html).toContain('<span class="tk-lit">true</span>');
  });

  it('does not treat // in CSS as a comment', () => {
    expect(highlight('a { b: url(//x) }', 'css')).not.toContain('tk-com');
  });

  it('picks a language from the file extension', () => {
    expect(langOf('src/App.tsx')).toBe('js');
    expect(langOf('package.json')).toBe('json');
    expect(langOf('README.md')).toBe('text');
  });
});
