// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main className="p-4">
      <h1 id="title" className="font-bold text-[rgb(10,20,30)]">
        Hello from Tailwind
      </h1>
      <button id="count" onClick={() => setCount((c) => c + 1)}>
        count is {count}
      </button>
    </main>
  );
}
