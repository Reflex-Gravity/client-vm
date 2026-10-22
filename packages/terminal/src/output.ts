// SPDX-License-Identifier: Apache-2.0
// What sits between sanitized output and the terminal: writes coalesced per
// frame with a bounded backlog, links for the instance's own port URLs, and
// scrollback kept in sessionStorage so it survives a reload.

import type { Disposable, Instance } from '@clientvm/clientvm';
import type { TerminalLike } from './view.ts';

export interface ThrottleOptions {
  /** Characters written to the terminal per frame (default 65,536). */
  maxPerFrame?: number;
  /**
   * Characters waiting to be written before the oldest are skipped (default
   * 1,048,576). A flood (`yes`, a runaway log) then costs the page a bounded
   * amount of work and memory.
   */
  maxBacklog?: number;
}

export interface PersistOptions {
  /** The storage key, e.g. `clientvm:terminal:<instance-id>`. */
  key: string;
  /** Default `sessionStorage`, which keeps a tab's scrollback across reloads. */
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  /** Characters kept (default 200,000; the oldest go first). */
  maxChars?: number;
}

export interface OutputOptions {
  /** Coalesce and bound writes (default on). */
  throttle?: boolean | ThrottleOptions;
  /**
   * Turn `http://localhost:<port>` in output into a link to the instance's
   * preview URL for that port (default on when the instance reports ports).
   */
  linkPorts?: boolean;
  /** Keep the output in storage and write it back when the view is attached again. */
  persist?: PersistOptions;
}

export type PortSource = Partial<Pick<Instance, 'onPortOpen' | 'onPortClose'>>;

export interface TerminalWriter extends Disposable {
  write(text: string): void;
  /** Writes everything queued now (tests, and before a final message). */
  flush(): void;
}

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const RESTORED = `${DIM}[restored from before the page reloaded]${RESET}\r\n`;
const SGR = '(?:\\x1b\\[[0-9;]*m)*';
/** A local URL, with colour codes allowed inside it (Vite colours the port). */
const LOCAL_URL = new RegExp(
  `https?://(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\])${SGR}:${SGR}(\\d{1,5})${SGR}((?:/[^\\s\\x1b'"<>]*)?)`,
  'g',
);

const schedule: (fn: () => void) => void =
  typeof requestAnimationFrame === 'function'
    ? (fn) => void requestAnimationFrame(() => fn())
    : (fn) => void setTimeout(fn, 16);

/** Wraps local URLs whose port the instance has opened in OSC 8 links to its preview URL. */
export function createPortLinker(instance: PortSource): {
  linkify(text: string): string;
  dispose(): void;
} {
  const urls = new Map<number, string>();
  const subs: Disposable[] = [];
  if (instance.onPortOpen) subs.push(instance.onPortOpen((port, url) => urls.set(port, url)));
  if (instance.onPortClose) subs.push(instance.onPortClose((port) => urls.delete(port)));
  return {
    linkify(text) {
      if (urls.size === 0 || !text.includes('://')) return text;
      return text.replace(LOCAL_URL, (match, port: string, path: string) => {
        const base = urls.get(Number(port));
        if (!base) return match;
        const target = new URL(path || '/', base).href;
        return `\x1b]8;;${target}\x1b\\${match}\x1b]8;;\x1b\\`;
      });
    },
    dispose() {
      for (const s of subs) s.dispose();
    },
  };
}

/** Drops the oldest text of `queue` so at most `keep` characters remain, cutting at a line. */
function skipOldest(queue: string, keep: number): { rest: string; skipped: number } {
  let cut = queue.length - keep;
  const nl = queue.indexOf('\n', cut);
  if (nl !== -1) cut = nl + 1;
  return { rest: queue.slice(cut), skipped: cut };
}

/** Builds the writer `attachShell` and `attachActivityView` draw through. */
export function createTerminalWriter(
  term: TerminalLike,
  instance: PortSource,
  opts: OutputOptions = {},
): TerminalWriter {
  const throttle =
    opts.throttle === false ? null : opts.throttle === true ? {} : (opts.throttle ?? {});
  const maxPerFrame = throttle?.maxPerFrame ?? 65_536;
  const maxBacklog = throttle?.maxBacklog ?? 1_048_576;
  const linker = opts.linkPorts === false ? null : createPortLinker(instance);
  const persist = opts.persist;
  const storage =
    persist && (persist.storage ?? (typeof sessionStorage === 'undefined' ? null : sessionStorage));
  const maxChars = persist?.maxChars ?? 200_000;

  let kept = '';
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    try {
      storage?.setItem(persist!.key, kept);
    } catch {
      // Storage full or unavailable: scrollback is a convenience.
    }
  };
  const keep = (text: string) => {
    if (!storage) return;
    kept += text;
    if (kept.length > maxChars) kept = skipOldest(kept, maxChars).rest;
    saveTimer ??= setTimeout(save, 500);
  };
  const out = (text: string) => {
    term.write(text);
    keep(text);
  };

  if (storage) {
    let previous: string | null = null;
    try {
      previous = storage.getItem(persist!.key);
    } catch {
      // unavailable
    }
    if (previous) {
      term.write(previous);
      term.write(`${previous.endsWith('\n') ? '' : '\r\n'}${RESTORED}`);
      kept = previous;
    }
  }
  const onHide = () => save();
  if (storage && typeof addEventListener === 'function') addEventListener('pagehide', onHide);

  let queue = '';
  let scheduled = false;
  let disposed = false;
  const flushSome = (all: boolean) => {
    scheduled = false;
    if (!queue) return;
    const n = all ? queue.length : maxPerFrame;
    out(queue.slice(0, n));
    queue = queue.slice(n);
    if (queue && !disposed) {
      scheduled = true;
      schedule(() => flushSome(false));
    }
  };

  return {
    write(text) {
      if (!text || disposed) return;
      const linked = linker ? linker.linkify(text) : text;
      if (!throttle) {
        out(linked);
        return;
      }
      queue += linked;
      if (queue.length > maxBacklog) {
        const { rest, skipped } = skipOldest(queue, Math.floor(maxBacklog / 2));
        queue = `${RESET}\r\n${DIM}[clientvm: ${skipped} characters of output skipped]${RESET}\r\n${rest}`;
      }
      if (!scheduled) {
        scheduled = true;
        schedule(() => flushSome(false));
      }
    },
    flush() {
      flushSome(true);
    },
    dispose() {
      if (disposed) return;
      flushSome(true);
      disposed = true;
      linker?.dispose();
      if (storage) {
        save();
        if (typeof removeEventListener === 'function') removeEventListener('pagehide', onHide);
      }
    },
  };
}
