// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1 id="title">Hello from Vite</h1>
      <button id="count" onClick={() => setCount((c) => c + 1)}>
        count is {count}
      </button>
    </main>
  );
}
