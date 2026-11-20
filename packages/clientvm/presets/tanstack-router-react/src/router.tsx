import { useState } from 'react';
import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';

const rootRoute = createRootRoute({
  component: () => (
    <>
      <nav>
        <Link to="/">Home</Link>
        <Link to="/about">About</Link>
      </nav>
      <main>
        <Outlet />
      </main>
    </>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: function Home() {
    const [count, setCount] = useState(0);
    return (
      <>
        <h1>TanStack Router + React</h1>
        <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>
        <p>
          Routes live in <code>src/router.tsx</code>.
        </p>
      </>
    );
  },
});

const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/about',
  component: () => <h1>About</h1>,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, aboutRoute]),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
