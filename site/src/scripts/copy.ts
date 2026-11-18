// SPDX-License-Identifier: Apache-2.0
// Buttons with `data-copy` put that text on the clipboard.
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  const label = button.textContent ?? '';
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset['copy'] ?? '');
      button.textContent = button.dataset['copiedLabel'] ?? 'copied';
    } catch {
      button.textContent = 'copy failed';
    }
    setTimeout(() => (button.textContent = label), 1600);
  });
}

export {};
