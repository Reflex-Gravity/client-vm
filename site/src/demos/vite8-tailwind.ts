// SPDX-License-Identifier: Apache-2.0
// Vite 8 + React 19 + Tailwind CSS 4: the e2e fixture's package.json and
// lockfile (test/fixtures/vite8-tailwind), so the install is the tested one,
// with an app that uses more utilities. rolldown, lightningcss and Tailwind's
// oxide scanner run as their WebAssembly builds (ADR 0013).
import type { DemoDefinition } from './types.ts';

const fixture = import.meta.glob<string>(
  [
    '../../../test/fixtures/vite8-tailwind/*.{json,html}',
    '../../../test/fixtures/vite8-tailwind/src/*',
  ],
  { query: '?raw', import: 'default', eager: true },
);
const FIXTURE = '../../../test/fixtures/vite8-tailwind/';

const FILES: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(fixture).map(([p, text]) => [p.slice(FIXTURE.length), text]),
  ),
  // Previews come from the sandbox's own host, which Vite rejects by default.
  'vite.config.js': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { allowedHosts: true },
});
`,
  'src/App.jsx': `import { useState } from 'react';

// Every class here is a Tailwind utility. Change one, or add a new one:
// the oxide scanner finds it and Vite hot-reloads the CSS.
export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main className="grid min-h-screen place-items-center bg-slate-100 p-8">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-xl">
        <p className="text-xs font-semibold tracking-widest text-slate-400 uppercase">
          Vite 8 · Tailwind 4
        </p>
        <h1 id="title" className="mt-2 text-3xl font-bold text-slate-900">
          Hello from Tailwind
        </h1>
        <p className="mt-3 text-slate-600">
          Styled by utilities, compiled in your browser tab.
        </p>
        <button
          id="count"
          className="mt-6 rounded-lg bg-emerald-500 px-4 py-2 font-semibold text-white hover:bg-emerald-600"
          onClick={() => setCount((c) => c + 1)}
        >
          count is {count}
        </button>
      </div>
    </main>
  );
}
`,
};

const demo: DemoDefinition = {
  files: FILES,
  editable: ['src/App.jsx', 'src/index.css', 'vite.config.js', 'package.json'],
  bootNote: 'Booting the sandbox…',
  start: 'npm run dev -- --clearScreen false < /dev/null &',
  background: true,
  serverProcess: /\bvite\b/,
};
export default demo;
