// SPDX-License-Identifier: Apache-2.0
// Lights random dots of the hero's dot matrix (components/GridPattern.astro),
// a few at a time, fading each out again. Pauses while the hero is off screen;
// does nothing with reduced motion.
const svg = document.querySelector<SVGSVGElement>('[data-grid]');
const layer = svg?.querySelector<SVGGElement>('[data-grid-cells]');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const CELLS = 36;
const STEP_MS = 140;
const DOT = 2;

if (svg && layer && !reduced) {
  const size = Number(svg.dataset['size']) || 22;
  const NS = 'http://www.w3.org/2000/svg';
  const cells = Array.from({ length: CELLS }, () => {
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('class', 'cell');
    r.setAttribute('width', String(DOT));
    r.setAttribute('height', String(DOT));
    layer.append(r);
    return r;
  });
  let next = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const step = () => {
    const { width, height } = svg.getBoundingClientRect();
    const cols = Math.max(1, Math.floor(width / size));
    const rows = Math.max(1, Math.floor(height / size));
    const cell = cells[next++ % cells.length]!;
    cell.classList.remove('on');
    // Move it while dark, then fade it in; it fades out when reused.
    setTimeout(() => {
      const offset = size / 2 - DOT / 2;
      cell.setAttribute('x', String(Math.floor(Math.random() * cols) * size + offset));
      cell.setAttribute('y', String(Math.floor(Math.random() * rows) * size + offset));
      cell.classList.add('on');
    }, 1400);
  };
  new IntersectionObserver(([entry]) => {
    if (entry?.isIntersecting) timer ??= setInterval(step, STEP_MS);
    else if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }).observe(svg);
}

export {};
