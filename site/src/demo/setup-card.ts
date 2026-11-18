// SPDX-License-Identifier: Apache-2.0
// The demo's setup card (markup in components/Demo.astro): Sandbox → Packages
// → Server steps, an elapsed timer, the latest output line, and the full live
// log, which follows new lines unless the visitor scrolled up to read.
// Lines come from code in the sandbox, so they are only ever set as text.
import type { SetupLine, SetupLog } from './setup-log.ts';
import type { Stage } from './run.ts';

const STAGES: Stage[] = ['sandbox', 'packages', 'server'];
const ERROR_LINE = /\b(error|ERR!|failed)\b|^exited with code [1-9]/i;
const WARN_LINE = /^npm warn\b|\bWARN\b|\bdeprecated\b/i;

function tone(l: SetupLine): string {
  if (l.kind === 'cmd') return 'cmd';
  if (l.kind === 'info') return 'info';
  if (ERROR_LINE.test(l.text)) return 'error';
  if (WARN_LINE.test(l.text)) return 'warn';
  return /^npm http\b/.test(l.text) ? 'http' : 'out';
}

const formatElapsed = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export interface SetupCard {
  /** Starts a new run against `log`: clears the card and starts the timer. */
  start(log: SetupLog): void;
  stage(stage: Stage): void;
  done(): void;
  fail(message: string): void;
  /** Shows or hides the whole card (it stays bound to its log). */
  show(visible: boolean): void;
  readonly visible: boolean;
  reset(): void;
}

export function createSetupCard(root: HTMLElement, onRetry: () => void): SetupCard {
  const q = <T extends HTMLElement>(name: string) => root.querySelector<T>(`[data-setup-${name}]`)!;
  const title = q('title');
  const elapsedEl = q('elapsed');
  const last = q('last');
  const logEl = q<HTMLOListElement>('log');
  const toggle = q<HTMLButtonElement>('toggle');
  const copy = q<HTMLButtonElement>('copy');
  const retry = q<HTMLButtonElement>('retry');
  const live = q('live');
  const steps = [...root.querySelectorAll<HTMLElement>('[data-step]')];

  let log: SetupLog | undefined;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let elapsed = 0;
  let rendered = 0; // highest seq on screen
  let pinned = true;
  let current: Stage = 'sandbox';

  const setOpen = (open: boolean) => {
    logEl.hidden = !open;
    last.hidden = open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Hide details' : 'Show details';
    if (open) logEl.scrollTop = logEl.scrollHeight;
  };
  toggle.addEventListener('click', () => setOpen(logEl.hidden === true));
  logEl.addEventListener('scroll', () => {
    pinned = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 8;
  });
  copy.addEventListener('click', async () => {
    const text = (log?.getLines() ?? [])
      .map((l) => (l.kind === 'cmd' ? `$ ${l.text}` : l.text))
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = 'copied';
    } catch {
      copy.textContent = 'copy failed';
    }
    setTimeout(() => (copy.textContent = 'copy'), 1500);
  });
  retry.addEventListener('click', onRetry);

  const render = () => {
    const lines = log?.getLines() ?? [];
    const first = lines[0]?.seq ?? Infinity;
    // Lines the log dropped from its front.
    while (
      logEl.firstElementChild &&
      Number((logEl.firstElementChild as HTMLElement).dataset['seq']) < first
    )
      logEl.firstElementChild.remove();
    const frag = document.createDocumentFragment();
    for (const l of lines) {
      if (l.seq <= rendered) continue;
      const li = document.createElement('li');
      li.dataset['seq'] = String(l.seq);
      li.className = tone(l);
      if (l.kind === 'cmd') {
        const ps = li.appendChild(document.createElement('span'));
        ps.className = 'ps';
        ps.textContent = '$ ';
      }
      li.append(l.text);
      frag.append(li);
      rendered = l.seq;
    }
    logEl.append(frag);
    if (pinned) logEl.scrollTop = logEl.scrollHeight;
    const latest = lines.at(-1);
    last.textContent = latest ? (latest.kind === 'cmd' ? `$ ${latest.text}` : latest.text) : '';
    if (latest && (latest.kind === 'cmd' || latest.kind === 'info')) live.textContent = latest.text;
  };

  const paintSteps = (failed: boolean, finished: boolean) => {
    const at = STAGES.indexOf(current);
    for (const li of steps) {
      const i = STAGES.indexOf(li.dataset['step'] as Stage);
      const state = finished || i < at ? 'done' : i > at ? 'todo' : failed ? 'failed' : 'active';
      li.dataset['state'] = state;
      if (state === 'active') li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    }
  };

  const stopTimer = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const card: SetupCard = {
    start(next) {
      card.reset();
      log = next;
      unsubscribe = next.subscribe(render);
      root.hidden = false;
      timer = setInterval(() => (elapsedEl.textContent = formatElapsed(++elapsed)), 1000);
      render();
    },
    stage(stage) {
      current = stage;
      paintSteps(false, false);
    },
    done() {
      stopTimer();
      root.dataset['state'] = 'done';
      title.textContent = `Ready in ${formatElapsed(elapsed)}`;
      paintSteps(false, true);
    },
    fail(message) {
      stopTimer();
      root.dataset['state'] = 'failed';
      title.textContent = 'Setup failed';
      live.textContent = `Setup failed: ${message}`;
      retry.hidden = false;
      paintSteps(true, false);
      setOpen(true);
    },
    show(visible) {
      root.hidden = !visible;
      if (visible && pinned) logEl.scrollTop = logEl.scrollHeight;
    },
    get visible() {
      return !root.hidden;
    },
    reset() {
      stopTimer();
      unsubscribe?.();
      unsubscribe = undefined;
      log = undefined;
      elapsed = 0;
      rendered = 0;
      pinned = true;
      current = 'sandbox';
      elapsedEl.textContent = '0:00';
      title.textContent = 'Setting up';
      last.textContent = '';
      live.textContent = '';
      logEl.replaceChildren();
      retry.hidden = true;
      delete root.dataset['state'];
      paintSteps(false, false);
      setOpen(true);
      root.hidden = true;
    },
  };
  card.reset();
  return card;
}
