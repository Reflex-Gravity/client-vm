// SPDX-License-Identifier: Apache-2.0
// Wires the demo's picker, buttons and "try" chips (components/Demo.astro).
// Kept small: the runtime (./run.ts, ClientVM and xterm.js) and a demo's files
// (../demos/<slug>.ts) are imported only when a visitor starts it.
import { checkSupport } from './support.ts';
import { createEditor } from './editor.ts';
import { demoOf, loadDefinition, type SetupStep } from '../demos/catalog.ts';
import type { RunningDemo } from './run.ts';

const root = document.querySelector<HTMLElement>('[data-demo]');
const $ = <T extends HTMLElement>(name: string) =>
  document.querySelector<T>(`[data-demo-${name}]`)!;
const all = <T extends HTMLElement>(selector: string) => [
  ...document.querySelectorAll<T>(selector),
];

if (root) {
  const overlay = $('overlay');
  const choices = $('choices');
  const note = $('note');
  const termEl = $('term');
  const preview = $<HTMLIFrameElement>('preview');
  const empty = $('empty');
  const port = $('port');
  const reset = $<HTMLButtonElement>('reset');
  const bar = $('bar');
  const emptyText = $('empty-text');
  const stepItems = all<HTMLLIElement>('[data-demo-steps] li');
  const status = (text: string) => ($('status').textContent = text);
  const editorState = document.querySelector<HTMLElement>('[data-editor-state]')!;
  const editor = createEditor(
    document.querySelector<HTMLElement>('[data-editor]')!,
    (text) => (editorState.textContent = text),
  );
  const picks = all<HTMLButtonElement>('[data-demo-pick]');
  const buttons = all<HTMLButtonElement>('[data-demo-start]');
  const chipGroups = all<HTMLElement>('[data-demo-chips]');
  const chips = all<HTMLButtonElement>('[data-demo-try]');

  /** The demos this page offers, in the picker's order. */
  const slugs = buttons.map((b) => b.dataset['demoStart']!);
  const isDemo = (v: string | undefined): v is string => v !== undefined && slugs.includes(v);
  let selected = slugs[0]!;
  let running: RunningDemo | undefined;
  let runningMode: string | undefined;
  /** Bumped on every start and reset, so a stale setup cannot touch the page. */
  let run = 0;

  /** The scan line and spinner run while setup is in progress. */
  const busy = (on: boolean) => {
    for (const el of [root, bar]) {
      if (on) el.dataset['busy'] = '';
      else delete el.dataset['busy'];
    }
  };

  /** Lights the setup strip up to `step`; undefined clears it. */
  const showStep = (mode: string, step: SetupStep | undefined) => {
    const steps = demoOf(mode)?.steps ?? [];
    const at = step ? steps.indexOf(step) : -1;
    for (const li of stepItems) {
      const i = steps.indexOf(li.dataset['step'] as SetupStep);
      li.classList.toggle('skip', i < 0);
      li.classList.toggle('done', i >= 0 && (i < at || (step === 'ready' && i === at)));
      li.classList.toggle('now', i >= 0 && i === at && step !== 'ready');
    }
  };

  const select = (mode: string) => {
    selected = mode;
    for (const p of picks) p.setAttribute('aria-pressed', String(p.dataset['demoPick'] === mode));
    for (const b of buttons) b.hidden = b.dataset['demoStart'] !== mode;
    if (!running) showStep(mode, undefined);
  };

  const showChips = (mode: string | undefined, enabled: boolean) => {
    for (const g of chipGroups) g.hidden = g.dataset['demoChips'] !== mode;
    for (const c of chips) c.disabled = !enabled;
  };

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

  const start = async (mode: string) => {
    if (running) return;
    const id = ++run;
    for (const b of buttons) b.disabled = true;
    note.textContent = '';
    note.classList.remove('error');
    overlay.hidden = true;
    runningMode = mode;
    emptyText.textContent = demoOf(mode)?.previewHint ?? '';
    showChips(mode, false);
    showStep(mode, 'boot');
    busy(true);
    try {
      const [{ startDemo, APP }, definition] = await Promise.all([
        import('./run.ts'),
        loadDefinition(mode),
      ]);
      const demo = await startDemo(definition, termEl, {
        status: (text) => id === run && status(text),
        step: (step) => id === run && showStep(mode, step),
        preview: (url, p) => {
          if (id !== run) return;
          // Assigning src reloads the page, also after a server restart.
          preview.src = url;
          empty.hidden = true;
          port.textContent = `● port ${p}`;
        },
      });
      if (id !== run) return void demo.destroy();
      running = demo;
      reset.hidden = false;
      demo.focus();
      void editor.open(demo.instance.fs, APP, definition.editable);
      demo.setup.then(
        () => {
          if (id !== run) return;
          busy(false);
          showChips(mode, true);
        },
        () => {
          if (id !== run) return;
          busy(false);
          showChips(mode, true);
          status('setup failed: the terminal shows why');
        },
      );
    } catch (err) {
      if (id !== run) return;
      busy(false);
      runningMode = undefined;
      showChips(undefined, false);
      showStep(mode, undefined);
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
    runningMode = undefined;
    reset.hidden = true;
    showChips(undefined, false);
    showStep(selected, undefined);
    editor.clear();
    clearPreview();
    if (demo) {
      status('stopping…');
      await demo.destroy();
    }
    termEl.replaceChildren();
    status('idle');
  };

  for (const pick of picks) {
    pick.addEventListener('click', async () => {
      const mode = pick.dataset['demoPick'];
      if (!isDemo(mode) || mode === runningMode) return;
      select(mode);
      // Switching while one runs tears it down and starts the new one.
      if (runningMode !== undefined && support.ok) {
        await stop();
        void start(mode);
      }
    });
  }

  for (const button of buttons) {
    button.addEventListener('click', () => {
      const mode = button.dataset['demoStart'];
      if (isDemo(mode)) void start(mode);
    });
  }

  for (const chip of chips) {
    chip.addEventListener('click', async () => {
      const demo = running;
      const command = chip.dataset['demoTry'];
      if (!demo || !command) return;
      chip.classList.add('typing');
      try {
        await demo.type(command);
      } catch {
        // the terminal shows what happened
      } finally {
        chip.classList.remove('typing');
        if (demo === running) demo.focus();
      }
    });
  }

  reset.addEventListener('click', async () => {
    await stop();
    overlay.hidden = false;
  });

  select(selected);
}
