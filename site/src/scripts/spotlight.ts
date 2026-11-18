// SPDX-License-Identifier: Apache-2.0
// A soft light that follows the pointer across `[data-spotlight]` cards, like
// Magic UI's Magic Card: one listener per group sets --x/--y on the card under
// the pointer, and CSS draws the glow.
for (const group of document.querySelectorAll<HTMLElement>('[data-spotlight-group]')) {
  group.addEventListener('pointermove', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('[data-spotlight]');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--x', `${e.clientX - r.left}px`);
    card.style.setProperty('--y', `${e.clientY - r.top}px`);
  });
}

export {};
