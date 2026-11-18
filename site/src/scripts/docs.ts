// SPDX-License-Identifier: Apache-2.0
// Docs pages: a link on every section heading, and "Copy page", which puts the
// page's markdown (served next to it at /docs/<slug>.md) on the clipboard for
// pasting into an agent.

for (const h of document.querySelectorAll<HTMLHeadingElement>('.prose :is(h2, h3)[id]')) {
  const a = document.createElement('a');
  a.className = 'anchor';
  a.href = `#${h.id}`;
  a.setAttribute('aria-label', `Link to “${h.textContent ?? ''}”`);
  a.textContent = '#';
  h.append(a);
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy-page]')) {
  const label = button.textContent ?? '';
  button.addEventListener('click', async () => {
    try {
      const res = await fetch(button.dataset['copyPage'] ?? '');
      if (!res.ok) throw new Error(String(res.status));
      await navigator.clipboard.writeText(await res.text());
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => (button.textContent = label), 1600);
  });
}

export {};
