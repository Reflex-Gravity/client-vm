// SPDX-License-Identifier: Apache-2.0
// Wires the demo's buttons. Kept small: the runtime (./run.ts, ClientVM and
// xterm.js) is imported only when a visitor starts the demo.
import { checkSupport } from './support.ts';
import { createEditor } from './editor.ts';
import type { DemoMode, RunningDemo } from './run.ts';

const root = document.querySelector<HTMLElement>('[data-demo]');
const $ = <T extends HTMLElement>(name: string) =>
  document.querySelector<T>(`[data-demo-${name}]`)!;

if (root) {
  const overlay = $('overlay');
  const choices = $('choices');
  const note = $('note');
  const termEl = $('term');
  const preview = $<HTMLIFrameElement>('preview');
  const empty = $('empty');
  const port = $('port');
  const reset = $<HTMLButtonElement>('reset');
  const status = (text: string) => ($('status').textContent = text);
  const editorState = document.querySelector<HTMLElement>('[data-editor-state]')!;
  const editor = createEditor(
    document.querySelector<HTMLElement>('[data-editor]')!,
    (text) => (editorState.textContent = text),
  );
  /** Runs the border beam (components/Demo.astro) while setup is in progress. */
  const busy = (on: boolean) => {
    if (on) root.dataset['busy'] = '';
    else delete root.dataset['busy'];
  };
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-demo-start]')];
  let running: RunningDemo | undefined;
  /** Bumped on every start and reset, so a stale setup cannot touch the page. */
  let run = 0;

  const fail = (message: string) => {
    overlay.hidden = false;
    note.textContent = message;
    note.classList.add('error');
  };

  const support = checkSupport();
  if (!support.ok) {
    choices.hidden = true;
    fail(support.reason);
    status('unsupported browser');
  }

  const clearPreview = () => {
    preview.removeAttribute('src');
    empty.hidden = false;
    port.textContent = '';
  };

  const start = async (mode: DemoMode) => {
    if (running) return;
    const id = ++run;
    for (const b of buttons) b.disabled = true;
    note.classList.remove('error');
    overlay.hidden = true;
    busy(true);
    try {
      const { startDemo, APP, EDITABLE } = await import('./run.ts');
      const demo = await startDemo(mode, termEl, {
        status: (text) => id === run && status(text),
        preview: (url, p) => {
          if (id !== run) return;
          // Assigning src reloads the page, also after a server restart.
          preview.src = url;
          empty.hidden = true;
          port.textContent = `port ${p}`;
        },
      });
      if (id !== run) return void demo.destroy();
      running = demo;
      reset.hidden = false;
      demo.focus();
      void editor.open(demo.instance.fs, APP, EDITABLE[mode]);
      demo.setup.then(
        () => id === run && busy(false),
        () => {
          if (id !== run) return;
          busy(false);
          status('setup failed: the terminal shows why');
        },
      );
    } catch (err) {
      if (id !== run) return;
      busy(false);
      status('failed');
      fail(`The demo could not start: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      for (const b of buttons) b.disabled = false;
    }
  };

  const stop = async () => {
    run++;
    busy(false);
    const demo = running;
    running = undefined;
    reset.hidden = true;
    editor.clear();
    clearPreview();
    if (demo) {
      status('stopping…');
      await demo.destroy();
    }
    termEl.replaceChildren();
    status('idle');
  };

  for (const button of buttons) {
    button.addEventListener(
      'click',
      () => void start(button.dataset['demoStart'] === 'vite' ? 'vite' : 'express'),
    );
  }

  reset.addEventListener('click', async () => {
    await stop();
    overlay.hidden = false;
  });
}
