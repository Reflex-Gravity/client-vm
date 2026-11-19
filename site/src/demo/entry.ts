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

/** Why a boot usually fails, after the error itself. */
const LIKELY_CAUSE =
  'A dropped connection while npm or the WebAssembly build tools download is the usual cause. ' +
  'Retrying is usually worth it; the browser console has the details.';

if (root) {
  const overlay = $('overlay');
  const choices = $('choices');
  const note = $('note');
  const noteTitle = $('note-title');
  const termEl = $('term');
  const termHint = $('term-hint');
  const preview = $<HTMLIFrameElement>('preview');
  const agentPreview = $('agent-preview');
  const empty = $('empty');
  const port = $('port');
  const ports = $<HTMLSelectElement>('ports');
  const reload = $<HTMLButtonElement>('reload');
  const expand = $<HTMLButtonElement>('expand');
  const reset = $<HTMLButtonElement>('reset');
  const bar = $('bar');
  const firstRun = $('firstrun');
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
  const retries = all<HTMLButtonElement>('[data-demo-retry]');
  const chipGroups = all<HTMLElement>('[data-demo-chips]');
  const chips = all<HTMLButtonElement>('[data-demo-chips] .chip');

  /** The demos this page offers, in the picker's order. */
  const slugs = buttons.map((b) => b.dataset['demoStart']!);
  const isDemo = (v: string | undefined): v is string => v !== undefined && slugs.includes(v);
  let selected = slugs[0]!;
  let running: RunningDemo | undefined;
  let runningMode: string | undefined;
  /** Bumped on every start and reset, so a stale setup cannot touch the page. */
  let run = 0;
  /** The ports open in the running demo, and their preview URLs. */
  const open = new Map<number, string>();

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

  const showRetry = (where: 'overlay' | 'bar' | undefined) => {
    for (const r of retries) {
      r.hidden = where === undefined || (where === 'overlay') !== overlay.contains(r);
    }
  };

  /** The panel over the stage, with a title, a message and, after a failure, Retry. */
  const panel = (title: string, message: string, retry: boolean) => {
    overlay.hidden = false;
    choices.hidden = true;
    noteTitle.hidden = false;
    noteTitle.textContent = title;
    note.textContent = message;
    note.classList.add('error');
    showRetry(retry ? 'overlay' : undefined);
  };

  const support = checkSupport();
  if (!support.ok) {
    panel('Unsupported browser', support.reason, false);
    status('unsupported browser');
  }

  /** Shows `p` in the preview; assigning src reloads the page, also after a restart. */
  const showPort = (p: number) => {
    const url = open.get(p);
    if (url === undefined) return;
    preview.src = url;
    empty.hidden = true;
    port.textContent = `● port ${p}`;
    ports.value = String(p);
    reload.disabled = false;
  };

  /** The port picker appears once more than one server listens. */
  const drawPorts = () => {
    const list = [...open.keys()].sort((a, b) => a - b);
    ports.replaceChildren(
      ...list.map((p) => {
        const option = document.createElement('option');
        option.value = String(p);
        option.textContent = `port ${p}`;
        return option;
      }),
    );
    ports.hidden = list.length < 2;
    port.hidden = list.length >= 2;
  };

  const clearPreview = () => {
    open.clear();
    drawPorts();
    preview.removeAttribute('src');
    empty.hidden = false;
    port.textContent = '';
    reload.disabled = true;
  };

  const setExpanded = (on: boolean) => {
    if (on) root.dataset['fullPreview'] = '';
    else delete root.dataset['fullPreview'];
    expand.setAttribute('aria-pressed', String(on));
  };

  const start = async (mode: string) => {
    if (running) return;
    const id = ++run;
    for (const b of buttons) b.disabled = true;
    note.textContent = '';
    note.classList.remove('error');
    noteTitle.hidden = true;
    overlay.hidden = true;
    choices.hidden = false;
    showRetry(undefined);
    firstRun.hidden = true;
    termHint.hidden = true;
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
      const demo = await startDemo(
        definition,
        termEl,
        {
          status: (text) => id === run && status(text),
          step: (step) => id === run && showStep(mode, step),
          firstRun: () => {
            if (id === run) firstRun.hidden = false;
          },
          preview: (url, p) => {
            if (id !== run) return;
            open.set(p, url);
            drawPorts();
            // The newest server is the one to look at.
            showPort(p);
          },
          portClosed: (p) => {
            if (id !== run) return;
            open.delete(p);
            drawPorts();
            // A restart closes and opens the same port; another one shows meanwhile.
            const next = [...open.keys()].at(-1);
            if (ports.value === String(p) && next !== undefined) showPort(next);
          },
        },
        definition.agentTools ? { agentPreview } : {},
      );
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
          firstRun.hidden = true;
          termHint.hidden = false;
        },
        () => {
          if (id !== run) return;
          busy(false);
          showChips(mode, true);
          status('setup failed: the terminal shows why');
          showRetry('bar');
        },
      );
    } catch (err) {
      if (id !== run) return;
      busy(false);
      runningMode = undefined;
      showChips(undefined, false);
      showStep(mode, undefined);
      status('failed');
      const message = err instanceof Error ? err.message : String(err);
      panel('The sandbox failed to boot', `${message}. ${LIKELY_CAUSE}`, true);
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
    showRetry(undefined);
    termHint.hidden = true;
    firstRun.hidden = true;
    setExpanded(false);
    editor.clear();
    clearPreview();
    agentPreview.replaceChildren();
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

  for (const retry of retries) {
    retry.addEventListener('click', async () => {
      await stop();
      void start(selected);
    });
  }

  // The hint goes once the visitor uses the terminal.
  for (const type of ['pointerdown', 'keydown'] as const) {
    termEl.addEventListener(type, () => (termHint.hidden = true));
  }

  ports.addEventListener('change', () => showPort(Number(ports.value)));
  reload.addEventListener('click', () => {
    const p = Number(ports.hidden ? [...open.keys()].at(-1) : ports.value);
    if (open.has(p)) showPort(p);
  });
  expand.addEventListener('click', () => setExpanded(!('fullPreview' in root.dataset)));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && 'fullPreview' in root.dataset) setExpanded(false);
  });

  for (const chip of chips) {
    chip.addEventListener('click', async () => {
      const demo = running;
      const command = chip.dataset['demoTry'];
      const tool = chip.dataset['demoTool'];
      if (!demo || (!command && !tool)) return;
      termHint.hidden = true;
      chip.classList.add('typing');
      try {
        if (tool) {
          const { name, input } = JSON.parse(tool) as {
            name: string;
            input: Record<string, unknown>;
          };
          await demo.callTool(name, input);
        } else if (command) {
          await demo.type(command);
        }
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
