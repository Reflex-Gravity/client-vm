// SPDX-License-Identifier: Apache-2.0
// Types out the hero's sessions (components/Hero.astro) once they are on
// screen: the selected tab plays, then, after a pause shown by the meter, the
// next tab is selected and plays. Picking a tab plays it and stops the
// rotation. The markup already holds every session, so without JavaScript or
// with reduced motion nothing changes.
const tablist = document.querySelector<HTMLElement>('[data-transcript-tabs]');
const meter = document.querySelector<HTMLElement>('[data-transcript-meter]');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const PAUSE_MS = 3200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bumped on every play, so an older play stops typing. */
let generation = 0;
let rotate = true;

async function play(root: HTMLElement): Promise<boolean> {
  const id = ++generation;
  const live = () => id === generation;
  const lines = [...root.querySelectorAll<HTMLElement>('.line')];
  const texts = (root.dataset['texts'] ??= JSON.stringify(
    lines.map((line) => line.querySelector<HTMLElement>('.t')?.textContent ?? ''),
  ));
  const original = JSON.parse(texts) as string[];
  for (const [i, line] of lines.entries()) {
    line.hidden = true;
    const t = line.querySelector<HTMLElement>('.t');
    if (t) t.textContent = original[i] ?? '';
  }
  for (const [i, line] of lines.entries()) {
    if (!live()) return false;
    const t = line.querySelector<HTMLElement>('.t');
    if (!t) continue;
    line.hidden = false;
    if (line.classList.contains('cmd')) {
      t.textContent = '';
      await sleep(320);
      for (const ch of original[i] ?? '') {
        if (!live()) return false;
        t.textContent += ch;
        await sleep(16 + Math.random() * 34);
      }
      await sleep(260);
    } else {
      await sleep(line.classList.contains('dim') ? 520 : 200);
    }
  }
  return live();
}

function runMeter(ms: number): void {
  if (!meter) return;
  meter.style.transition = 'none';
  meter.style.transform = 'scaleX(0)';
  void meter.offsetWidth;
  meter.style.transition = `transform ${ms}ms linear`;
  meter.style.transform = 'scaleX(1)';
}

function stopMeter(): void {
  if (!meter) return;
  meter.style.transition = 'none';
  meter.style.transform = 'scaleX(0)';
}

if (tablist && !reduced) {
  const tabs = [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panelOf = (tab: HTMLButtonElement) =>
    document.getElementById(tab.getAttribute('aria-controls') ?? '');

  const cycle = async (tab: HTMLButtonElement) => {
    const panel = panelOf(tab);
    if (!panel) return;
    stopMeter();
    const finished = await play(panel);
    if (!finished || !rotate) return;
    runMeter(PAUSE_MS);
    const id = generation;
    await sleep(PAUSE_MS);
    if (id !== generation || !rotate) return;
    // Selecting goes through scripts/tabs.ts, so the panels swap as on a click.
    const next = tabs[(tabs.indexOf(tab) + 1) % tabs.length];
    if (next) {
      next.dispatchEvent(new CustomEvent('click'));
      void cycle(next);
    }
  };

  for (const tab of tabs) {
    tab.addEventListener('click', (e) => {
      // The rotation's own synthetic clicks only swap the panel.
      if (!e.isTrusted) return;
      rotate = false;
      stopMeter();
      void cycle(tab);
    });
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      rotate = false;
      // scripts/tabs.ts has moved the selection by now.
      queueMicrotask(() => {
        const selected = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
        if (selected) void cycle(selected);
      });
    });
  }

  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    observer.disconnect();
    const first = tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[0];
    if (first) void cycle(first);
  });
  observer.observe(tablist.closest('.window') ?? tablist);
}

export {};
