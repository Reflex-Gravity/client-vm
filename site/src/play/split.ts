// SPDX-License-Identifier: Apache-2.0
// Resizable panes for the playground: a separator sets a CSS custom property
// on its grid's root as it is dragged, or with the arrow keys (Shift for big
// steps). Sizes are kept in sessionStorage for the tab.

export interface SplitSpec {
  /** The custom property set on `root`, e.g. `--side`. */
  prop: string;
  /** Pixels or percent of `area`. */
  unit: 'px' | '%';
  axis: 'x' | 'y';
  min: number;
  max: number;
  /** The element the size is measured within (percent) and from (its start edge). */
  area: () => HTMLElement;
}

const STEP = { px: 16, '%': 2 };

export function makeSplit(root: HTMLElement, handle: HTMLElement, spec: SplitSpec): void {
  const key = `clientvm-play${spec.prop}`;
  const set = (value: number) => {
    const v = Math.min(spec.max, Math.max(spec.min, value));
    root.style.setProperty(spec.prop, `${v}${spec.unit}`);
    handle.setAttribute('aria-valuenow', String(Math.round(v)));
    sessionStorage.setItem(key, String(v));
    return v;
  };
  handle.setAttribute('aria-valuemin', String(spec.min));
  handle.setAttribute('aria-valuemax', String(spec.max));
  const saved = Number(sessionStorage.getItem(key));
  let current = Number.isFinite(saved) && saved > 0 ? set(saved) : NaN;

  /** The size the pointer at (x, y) asks for. */
  const measure = (x: number, y: number) => {
    const box = spec.area().getBoundingClientRect();
    const offset = spec.axis === 'x' ? x - box.left : box.bottom - y;
    const whole = spec.axis === 'x' ? box.width : box.height;
    return spec.unit === 'px' ? offset : (offset / whole) * 100;
  };

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.dataset['dragging'] = '';
    const move = (m: PointerEvent) => (current = set(measure(m.clientX, m.clientY)));
    const up = () => {
      delete handle.dataset['dragging'];
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });

  handle.addEventListener('keydown', (e) => {
    // The terminal's size grows upwards, from the bottom edge.
    const grow = spec.axis === 'x' ? 'ArrowRight' : 'ArrowUp';
    const shrink = spec.axis === 'x' ? 'ArrowLeft' : 'ArrowDown';
    if (e.key !== grow && e.key !== shrink) return;
    e.preventDefault();
    if (Number.isNaN(current)) {
      const box = handle.getBoundingClientRect();
      current = measure(box.left, box.top);
    }
    const step = STEP[spec.unit] * (e.shiftKey ? 4 : 1);
    current = set(current + (e.key === grow ? step : -step));
  });
}
