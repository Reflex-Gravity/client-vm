// SPDX-License-Identifier: Apache-2.0
// The "How it works" tour (components/HowItWorks.astro): shows one step at a
// time, in the diagram and the list, and moves on every STEP_MS while the
// section is on screen. Picking a step shows it and pauses the tour; the
// toggle resumes it. With reduced motion the tour does not advance on its own.
const root = document.querySelector<HTMLElement>('[data-how]');
const STEP_MS = 5000;

if (root) {
  const svg = root.querySelector<SVGSVGElement>('[data-how-diagram]')!;
  const list = root.querySelector<HTMLElement>('[data-how-steps]')!;
  const toggle = root.querySelector<HTMLButtonElement>('[data-how-toggle]')!;
  const steps = [...root.querySelectorAll<HTMLButtonElement>('[data-how-step]')];
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let current = 1;
  let playing = !reduced;
  let visible = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  list.style.setProperty('--how-ms', `${STEP_MS}ms`);

  const show = (n: number) => {
    current = n;
    svg.dataset['step'] = String(n);
    for (const s of steps) {
      const on = Number(s.dataset['howStep']) === n;
      s.setAttribute('aria-pressed', String(on));
      // Restart the active step's timer bar.
      s.classList.remove('timed');
      if (on && playing) {
        void s.offsetWidth;
        s.classList.add('timed');
      }
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!playing || !visible) return;
    timer = setTimeout(() => {
      show((current % steps.length) + 1);
      schedule();
    }, STEP_MS);
  };

  const setPlaying = (on: boolean) => {
    playing = on;
    toggle.textContent = on ? 'pause' : 'play tour';
    show(current);
    schedule();
  };

  for (const s of steps) {
    s.addEventListener('click', () => {
      playing = false;
      toggle.textContent = 'play tour';
      show(Number(s.dataset['howStep']));
      schedule();
    });
  }
  toggle.addEventListener('click', () => {
    // Resuming moves on from the step in view.
    if (!playing) show((current % steps.length) + 1);
    setPlaying(!playing);
  });

  new IntersectionObserver(
    ([entry]) => {
      visible = entry?.isIntersecting ?? false;
      if (visible) {
        svg.unpauseAnimations();
        show(current);
      } else svg.pauseAnimations();
      schedule();
    },
    { threshold: 0.35 },
  ).observe(root);

  list.dataset['ready'] = '';
  toggle.hidden = false;
  toggle.textContent = playing ? 'pause' : 'play tour';
  show(current);
}

export {};
