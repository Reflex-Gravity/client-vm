// SPDX-License-Identifier: Apache-2.0

export type FsEvent =
  | { type: 'create' | 'modify' | 'delete'; path: string }
  | { type: 'rename'; from: string; to: string };

export type WatchListener = (events: FsEvent[]) => void;

interface Watch {
  path: string;
  recursive: boolean;
  listener: WatchListener;
}

/** Dispatches VFS change events to path watchers, batched per microtask. */
export class Watchers {
  private readonly watches = new Set<Watch>();
  private pending: FsEvent[] = [];
  private scheduled = false;

  get active(): boolean {
    return this.watches.size > 0;
  }

  add(path: string, recursive: boolean, listener: WatchListener): () => void {
    const watch: Watch = { path, recursive, listener };
    this.watches.add(watch);
    return () => this.watches.delete(watch);
  }

  emit(event: FsEvent): void {
    const last = this.pending[this.pending.length - 1];
    // Coalesce runs of identical events (e.g. many writes to one file).
    if (
      last &&
      event.type !== 'rename' &&
      last.type === event.type &&
      'path' in last &&
      last.path === event.path
    ) {
      return;
    }
    this.pending.push(event);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush(): void {
    const events = this.pending;
    this.pending = [];
    this.scheduled = false;
    for (const watch of this.watches) {
      const matching = events.filter((e) =>
        e.type === 'rename'
          ? matches(watch, e.from) || matches(watch, e.to)
          : matches(watch, e.path),
      );
      if (matching.length > 0) watch.listener(matching);
    }
  }
}

function matches(watch: Watch, path: string): boolean {
  if (path === watch.path) return true;
  const prefix = watch.path === '/' ? '/' : `${watch.path}/`;
  if (!path.startsWith(prefix)) return false;
  return watch.recursive || !path.slice(prefix.length).includes('/');
}
