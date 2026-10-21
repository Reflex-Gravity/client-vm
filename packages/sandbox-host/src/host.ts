// SPDX-License-Identifier: Apache-2.0
// Example host app and e2e test harness. It runs on the plain app origin
// (http://localhost:<port>) and is NOT cross-origin isolated; each instance
// lives on http://<id>.localhost:<port>.
import { createClientVM } from '@clientvm/clientvm';
import type { ExecOptions, ExecResult, Instance, InstanceOptions } from '@clientvm/clientvm';
import type { RunResult, SpawnRequest } from '@clientvm/protocol';

/** Test/automation surface on `window.__clientvm`. Ids cross the page boundary, objects don't. */
export interface HostApi {
  hostCrossOriginIsolated: boolean;
  createInstance(options?: InstanceOptions): Promise<string>;
  run(id: string, request: SpawnRequest): Promise<RunResult>;
  /** `Instance.exec`: a command line through the shell. */
  exec(id: string, commandLine: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Spawns via the public API and collects streamed output until exit. */
  spawnAndCollect(
    id: string,
    cmd: string,
    args: string[],
    killAfterMs?: number,
  ): Promise<{ stdout: string[]; stderr: string; code: number; signal?: string }>;
  writeFile(id: string, path: string, data: string): Promise<void>;
  readFile(id: string, path: string): Promise<string>;
  readdir(id: string, path: string): Promise<string[]>;
  snapshot(id: string): Promise<string>;
  fork(id: string): Promise<string>;
  destroy(id: string, purge?: boolean): Promise<void>;
  flush(id: string): Promise<void>;
  /** Serves a directory on a port and resolves with the preview URL once it is routable. */
  serveStatic(id: string, port: number, dir: string): Promise<string>;
  /** Loads `url` in a visible preview iframe and resolves when it has loaded. */
  openPreview(url: string): Promise<void>;
  usage(id: string): Promise<unknown>;
  list(): string[];
  watch(id: string, path: string): Promise<() => unknown[]>;
}

declare global {
  interface Window {
    __clientvm: HostApi;
  }
}

const vm = createClientVM({
  sandboxOrigin: (id) => `${location.protocol}//${id}.${location.host}`,
});
const instances = new Map<string, Instance>();

const get = (id: string): Instance => {
  const instance = instances.get(id);
  if (!instance) throw new Error(`no instance ${id}`);
  return instance;
};
const keep = (instance: Instance): string => {
  instances.set(instance.id, instance);
  return instance.id;
};

async function drain(
  stream: ReadableStream<Uint8Array>,
  onChunk: (s: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>)
    onChunk(decoder.decode(chunk));
}

window.__clientvm = {
  hostCrossOriginIsolated: globalThis.crossOriginIsolated === true,
  createInstance: async (options) => keep(await vm.createInstance(options)),
  run: (id, request) =>
    (get(id) as Instance & { debugRun(r: SpawnRequest): Promise<RunResult> }).debugRun(request),
  exec: (id, commandLine, opts) => get(id).exec(commandLine, opts),
  async spawnAndCollect(id, cmd, args, killAfterMs) {
    const proc = await get(id).spawn(cmd, args);
    const stdout: string[] = [];
    let stderr = '';
    if (killAfterMs !== undefined) setTimeout(() => proc.kill('SIGKILL'), killAfterMs);
    await Promise.all([
      drain(proc.stdout, (s) => stdout.push(s)),
      drain(proc.stderr, (s) => (stderr += s)),
    ]);
    const exit = await proc.exit;
    return { stdout, stderr, ...exit };
  },
  writeFile: (id, path, data) => get(id).fs.writeFile(path, data),
  readFile: async (id, path) => new TextDecoder().decode(await get(id).fs.readFile(path)),
  readdir: async (id, path) => (await get(id).fs.readdir(path)).map((e) => e.name),
  snapshot: (id) => get(id).snapshot(),
  fork: async (id) => keep(await get(id).fork()),
  async destroy(id, purge) {
    await get(id).destroy(purge ? { purge } : {});
    instances.delete(id);
  },
  flush: (id) => get(id).flush(),
  async serveStatic(id, port, dir) {
    const instance = get(id) as Instance & {
      debugServeStatic(p: number, d: string): Promise<void>;
    };
    const url = new Promise<string>((resolve) => {
      const sub = instance.onPortOpen((p, u) => {
        if (p !== port) return;
        queueMicrotask(() => sub.dispose());
        resolve(u);
      });
    });
    await instance.debugServeStatic(port, dir);
    return url;
  },
  openPreview(url) {
    return new Promise((resolve) => {
      const iframe = document.createElement('iframe');
      iframe.className = 'preview';
      iframe.src = url;
      iframe.addEventListener('load', () => resolve(), { once: true });
      document.body.append(iframe);
    });
  },
  usage: (id) =>
    (get(id) as Instance & { rpc: { call(m: 'usage'): Promise<unknown> } }).rpc.call('usage'),
  list: () => vm.listInstances().map((i) => i.id),
  async watch(id, path) {
    const events: unknown[] = [];
    get(id).fs.watch(path, (e) => events.push(e));
    // Give the watch registration a round trip before callers make changes.
    await get(id).fs.stat(path);
    return () => events;
  },
};

document.getElementById('status')!.textContent = 'ready';
