// SPDX-License-Identifier: Apache-2.0
// Types out the hero's transcript once it is on screen. The markup already
// holds the whole session, so without JavaScript or with reduced motion
// nothing changes.
const pre = document.querySelector<HTMLElement>('[data-transcript]');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function play(root: HTMLElement): Promise<void> {
  const lines = [...root.querySelectorAll<HTMLElement>('.line')];
  const texts = lines.map((line) => line.querySelector<HTMLElement>('.t')?.textContent ?? '');
  for (const line of lines) line.hidden = true;
  for (const [i, line] of lines.entries()) {
    const t = line.querySelector<HTMLElement>('.t');
    if (!t) continue;
    line.hidden = false;
    if (line.classList.contains('cmd')) {
      t.textContent = '';
      await sleep(350);
      for (const ch of texts[i] ?? '') {
        t.textContent += ch;
        await sleep(22 + Math.random() * 40);
      }
      await sleep(300);
    } else {
      await sleep(line.classList.contains('dim') ? 500 : 180);
    }
  }
}

if (pre && !reduced) {
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    observer.disconnect();
    void play(pre);
  });
  observer.observe(pre);
}

export {};
