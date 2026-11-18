// SPDX-License-Identifier: Apache-2.0
// Lights a few random cells of the hero grid (components/GridPattern.astro),
// one at a time, fading each out again. Pauses while the hero is off screen;
// does nothing with reduced motion.
const svg = document.querySelector<SVGSVGElement>('[data-grid]');
const layer = svg?.querySelector<SVGGElement>('[data-grid-cells]');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const CELLS = 14;
const STEP_MS = 650;

if (svg && layer && !reduced) {
  const size = Number(svg.dataset['size']) || 44;
  const NS = 'http://www.w3.org/2000/svg';
  const cells = Array.from({ length: CELLS }, () => {
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('class', 'cell');
    r.setAttribute('width', String(size - 1));
    r.setAttribute('height', String(size - 1));
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
      cell.setAttribute('x', String(Math.floor(Math.random() * cols) * size));
      cell.setAttribute('y', String(Math.floor(Math.random() * rows) * size));
      cell.classList.add('on');
    }, 1600);
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
