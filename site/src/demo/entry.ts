// SPDX-License-Identifier: Apache-2.0
// Wires the demo's buttons. Kept small: the runtime (./run.ts, ClientVM and
// xterm.js) is imported only when a visitor starts the demo.
import { checkSupport } from './support.ts';
import { createSetupCard } from './setup-card.ts';
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
  const logButton = $<HTMLButtonElement>('log');
  const status = (text: string) => ($('status').textContent = text);
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-demo-start]')];
  let running: RunningDemo | undefined;
  let lastMode: DemoMode = 'express';
  /** Bumped on every start and reset, so a stale setup cannot touch the page. */
  let run = 0;

  const card = createSetupCard($('setup'), () => void restart());

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
    logButton.hidden = true;
    logButton.setAttribute('aria-pressed', 'false');
  };

  logButton.addEventListener('click', () => {
    card.show(!card.visible);
    logButton.setAttribute('aria-pressed', String(card.visible));
  });

  const start = async (mode: DemoMode) => {
    if (running) return;
    lastMode = mode;
    const id = ++run;
    for (const b of buttons) b.disabled = true;
    note.classList.remove('error');
    overlay.hidden = true;
    empty.hidden = true;
    try {
      const { startDemo, SetupLog } = await import('./run.ts');
      const log = new SetupLog();
      card.start(log);
      const demo = await startDemo(mode, termEl, log, {
        status: (text) => id === run && status(text),
        stage: (stage) => id === run && card.stage(stage),
        preview: (url, p) => {
          if (id !== run) return;
          preview.src = url;
          port.textContent = `port ${p}`;
        },
      });
      if (id !== run) return void demo.destroy();
      running = demo;
      reset.hidden = false;
      demo.setup.then(
        () => {
          if (id !== run) return;
          card.done();
          // The preview takes over; the log stays one click away.
          setTimeout(() => {
            if (id !== run) return;
            card.show(false);
            logButton.hidden = false;
          }, 1200);
        },
        (err: unknown) => {
          if (id !== run) return;
          status('setup failed');
          card.fail(err instanceof Error ? err.message : String(err));
        },
      );
    } catch (err) {
      if (id !== run) return;
      status('failed');
      card.reset();
      empty.hidden = false;
      fail(`The demo could not start: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      for (const b of buttons) b.disabled = false;
    }
  };

  const stop = async () => {
    run++;
    const demo = running;
    running = undefined;
    reset.hidden = true;
    card.reset();
    clearPreview();
    if (demo) {
      status('stopping…');
      await demo.destroy();
    }
    termEl.replaceChildren();
    status('idle');
  };

  const restart = async () => {
    await stop();
    await start(lastMode);
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
