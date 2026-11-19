// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEMOS, definitionSlugs, loadDefinition } from './catalog.ts';
import { isPublished } from '../lib/docs.ts';

const repo = (path: string) => new URL(`../../../${path}`, import.meta.url);

describe('demo catalog', () => {
  it('has one definition module per demo, and no others', () => {
    expect(definitionSlugs().sort()).toEqual(DEMOS.map((d) => d.slug).sort());
    expect(new Set(DEMOS.map((d) => d.slug)).size).toBe(DEMOS.length);
  });

  it.each(DEMOS.map((d) => [d.slug, d] as const))('%s: copy, steps and chips', (_, demo) => {
    expect(demo.steps[0]).toBe('boot');
    expect(demo.steps.at(-1)).toBe('ready');
    expect(demo.triggers.length).toBeGreaterThan(0);
    for (const t of demo.triggers) expect(Boolean(t.command) !== Boolean(t.tool)).toBe(true);
    for (const d of demo.docs) expect(isPublished(d.slug), d.slug).toBe(true);
    expect(existsSync(repo(demo.source)), demo.source).toBe(true);
  });

  it.each(DEMOS.map((d) => [d.slug, d] as const))('%s: its definition', async (slug, demo) => {
    const def = await loadDefinition(slug);
    // A preset brings its own project (package.json and the rest).
    if (!def.preset)
      for (const file of def.editable) expect(Object.keys(def.files)).toContain(file);
    // Tool chips need the agent tools, and only an agent demo has them.
    expect(demo.triggers.some((t) => t.tool)).toBe(def.agentTools === true);
    // A demo that installs or starts something says so in its steps.
    expect(demo.steps.includes('install')).toBe(def.start !== undefined && def.install !== false);
    expect(demo.steps.includes('start')).toBe(def.start !== undefined);
  });

  it('loads the fixtures the end-to-end tests install', async () => {
    const tailwind = await loadDefinition('vite8-tailwind');
    expect(Object.keys(tailwind.files)).toEqual(
      expect.arrayContaining(['package.json', 'package-lock.json', 'index.html', 'src/main.jsx']),
    );
    expect(JSON.parse(tailwind.files['package.json']!).devDependencies.vite).toMatch(/^8\./);
    const chat = await loadDefinition('websocket-chat');
    expect(JSON.parse(chat.files['package.json']!).dependencies).toHaveProperty('ws');
    expect(Object.keys(chat.files)).toContain('package-lock.json');
  });
});
