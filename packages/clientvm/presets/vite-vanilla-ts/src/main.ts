// SPDX-License-Identifier: Apache-2.0
import './style.css';

const app = document.querySelector<HTMLElement>('#app')!;
let count = 0;

app.innerHTML = `
  <h1>Vite + TypeScript</h1>
  <button type="button" id="counter"></button>
  <p>Edit <code>src/main.ts</code> and save to reload.</p>
`;

const button = app.querySelector<HTMLButtonElement>('#counter')!;
const render = () => (button.textContent = `count is ${count}`);
button.addEventListener('click', () => {
  count += 1;
  render();
});
render();
