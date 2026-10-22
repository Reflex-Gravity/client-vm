// SPDX-License-Identifier: Apache-2.0
// `repl`: the module's surface, so tools that load it to offer a REPL (ts-node)
// still load; starting one throws, as `node` with no script does here.

import { NODE_BUILTINS } from './module/builtin-names.ts';

const unsupported = () => {
  const err = new Error('repl.start() is not available in ClientVM (no REPL yet)');
  (err as { code?: string }).code = 'ERR_CLIENTVM_UNSUPPORTED';
  return err;
};

/** A syntax error that means "more input needed" (multi-line input). */
class Recoverable extends SyntaxError {
  readonly err: Error;
  constructor(err: Error) {
    super(err.message);
    this.err = err;
  }
}

class REPLServer {
  constructor() {
    throw unsupported();
  }
}

export function createRepl(): Record<string, unknown> {
  return {
    start: () => {
      throw unsupported();
    },
    REPLServer,
    Recoverable,
    REPL_MODE_SLOPPY: Symbol('repl-sloppy'),
    REPL_MODE_STRICT: Symbol('repl-strict'),
    builtinModules: [...NODE_BUILTINS].filter((m) => !m.startsWith('_')),
    writer: undefined,
  };
}
