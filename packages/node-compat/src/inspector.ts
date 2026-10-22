// SPDX-License-Identifier: Apache-2.0
// `inspector` and `inspector/promises`: no debugger can attach, so `url()` is
// undefined (what tools such as Next.js check) and opening one or connecting
// a session throws. `console` is the global console, as in a process that was
// not started with --inspect.

import { EventEmitter } from './events.ts';

const unsupported = (what: string) => {
  const err = new Error(`${what} is not available in ClientVM (no inspector)`);
  (err as { code?: string }).code = 'ERR_INSPECTOR_NOT_AVAILABLE';
  return err;
};

class Session extends EventEmitter {
  connect(): void {
    throw unsupported('inspector.Session.connect()');
  }
  connectToMainThread(): void {
    throw unsupported('inspector.Session.connectToMainThread()');
  }
  disconnect(): void {}
  post(): never {
    throw unsupported('inspector.Session.post()');
  }
}

export function createInspector(): {
  inspector: Record<string, unknown>;
  promises: Record<string, unknown>;
} {
  const common = {
    url: (): undefined => undefined,
    open: () => {
      throw unsupported('inspector.open()');
    },
    close: () => {},
    waitForDebugger: () => {
      throw unsupported('inspector.waitForDebugger()');
    },
    console: globalThis.console,
    Network: {
      requestWillBeSent() {},
      responseReceived() {},
      loadingFinished() {},
      loadingFailed() {},
    },
  };
  return {
    inspector: { ...common, Session },
    promises: { ...common, Session },
  };
}
