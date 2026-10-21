// SPDX-License-Identifier: Apache-2.0
// Example host app and e2e test harness. It runs on the plain app origin
// (http://localhost:<port>) and is NOT cross-origin isolated; each instance
// lives on http://<id>.localhost:<port>.
import { createAgentTools } from '@clientvm/agent-api';
import type { AgentTools, ToolResult } from '@clientvm/agent-api';
import { createClientVM } from '@clientvm/clientvm';
import type {
  Capability,
  ExecOptions,
  ExecResult,
  Instance,
  InstanceId,
  InstanceOptions,
  MountSource,
  Preview,
} from '@clientvm/clientvm';
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
  /**
   * Spawns a long-running server and resolves with its preview URL once
   * `port` opens. Output is kept for {@link HostApi.output}.
   */
  startServer(
    id: string,
    cmd: string,
    args: string[],
    opts: { cwd?: string; env?: Record<string, string> },
    port: number,
  ): Promise<{ pid: number; url: string }>;
  /** Combined output so far of a process started with startServer. */
  output(pid: number): string;
  kill(id: string, pid: number): Promise<void>;
  writeFile(id: string, path: string, data: string): Promise<void>;
  readFile(id: string, path: string): Promise<string>;
  readdir(id: string, path: string): Promise<string[]>;
  snapshot(id: string): Promise<string>;
  fork(id: string, options?: InstanceOptions): Promise<string>;
  /** Host-authority grant (`ClientVM.grant`). */
  grant(to: string, cap: Capability): void;
  /** Runs an instance-scoped call and reports errors as values (for denial tests). */
  as(id: string, op: 'grant' | 'revoke', to: string, cap: Capability): Promise<Outcome>;
  as(id: string, op: 'send', to: string, message: unknown): Promise<Outcome>;
  as(id: string, op: 'fork', options?: InstanceOptions): Promise<Outcome>;
  as(id: string, op: 'mount', path: string, source: MountSource): Promise<Outcome>;
  as(id: string, op: 'unmount', path: string): Promise<Outcome>;
  capabilities(id: string): Capability[];
  /** Starts recording mailbox deliveries to `id` (host listener). */
  recordMail(id: string): void;
  mail(id: string): { from: string; message: unknown }[];
  /** Opens a driveable preview; resolves with a handle id. */
  drive(id: string, port: number, path?: string): Promise<number>;
  /** Calls a Preview method; Uint8Array results come back as `{ png: base64 }`. */
  previewCall(handle: number, method: string, ...args: unknown[]): Promise<unknown>;
  networkLog(id: string, since?: number): Promise<unknown[]>;
  /** `{ instanceMB }` from measureMemory (page + kernel worker; null when unavailable), waiting at most 30 s. */
  memory(id: string): Promise<{ instanceMB: number | null }>;
  /** Agent tools for an instance (`@clientvm/agent-api`); resolves with a handle. */
  /** Spawns via the public API, writes `chunks` to stdin, closes it, and collects stdout. */
  pipeThrough(
    id: string,
    cmd: string,
    args: string[],
    chunks: string[],
  ): Promise<{ stdout: string; code: number }>;
  agent(id: string): number;
  agentCall(handle: number, tool: string, input: unknown): Promise<ToolResult>;
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

export type Outcome = { ok: true; value?: unknown } | { ok: false; code: string; message: string };

declare global {
  interface Window {
    __clientvm: HostApi;
  }
}

const vm = createClientVM({
  sandboxOrigin: (id) => `${location.protocol}//${id}.${location.host}`,
});
const instances = new Map<string, Instance>();
const outputs = new Map<number, string>();
const processes = new Map<number, Awaited<ReturnType<Instance['spawn']>>>();

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

const mailLogs = new Map<string, { from: string; message: unknown }[]>();
const previews = new Map<number, Preview>();
const agents = new Map<number, AgentTools>();
let nextPreview = 1;

window.__clientvm = {
  hostCrossOriginIsolated: globalThis.crossOriginIsolated === true,
  createInstance: async (options) => keep(await vm.createInstance(options)),
  run: (id, request) =>
    (get(id) as Instance & { debugRun(r: SpawnRequest): Promise<RunResult> }).debugRun(request),
  exec: (id, commandLine, opts) => get(id).exec(commandLine, opts),
  async startServer(id, cmd, args, opts, port) {
    const instance = get(id);
    const url = new Promise<string>((resolve) => {
      const sub = instance.onPortOpen((p, u) => {
        if (p !== port) return;
        queueMicrotask(() => sub.dispose());
        resolve(u);
      });
    });
    const proc = await instance.spawn(cmd, args, opts);
    processes.set(proc.pid, proc);
    outputs.set(proc.pid, '');
    const append = (s: string) => outputs.set(proc.pid, (outputs.get(proc.pid) ?? '') + s);
    void drain(proc.stdout, append);
    void drain(proc.stderr, append);
    const exited = proc.exit.then(({ code }) => {
      throw new Error(`server exited with ${code}: ${outputs.get(proc.pid)}`);
    });
    return { pid: proc.pid, url: await Promise.race([url, exited]) };
  },
  output: (pid) => outputs.get(pid) ?? '',
  async kill(_id, pid) {
    const proc = processes.get(pid);
    proc?.kill('SIGTERM');
    await proc?.exit;
  },
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
  fork: async (id, options) => keep(await get(id).fork(options)),
  grant: (to, cap) => vm.grant(to as InstanceId, cap),
  async as(id: string, op: string, a?: unknown, b?: unknown): Promise<Outcome> {
    const instance = get(id);
    try {
      if (op === 'grant') await instance.grant(a as InstanceId, b as Capability);
      else if (op === 'revoke') await instance.revoke(a as InstanceId, b as Capability);
      else if (op === 'send') await instance.mailbox.send(a as string, b);
      else if (op === 'mount') await instance.fs.mount(a as string, b as MountSource);
      else if (op === 'unmount') await instance.fs.unmount(a as string);
      else if (op === 'fork')
        return { ok: true, value: keep(await instance.fork(a as InstanceOptions)) };
      return { ok: true };
    } catch (err) {
      const e = err as { code?: unknown; message?: unknown };
      return { ok: false, code: String(e.code), message: String(e.message) };
    }
  },
  capabilities: (id) => get(id).capabilities(),
  recordMail(id) {
    const log: { from: string; message: unknown }[] = [];
    mailLogs.set(id, log);
    get(id).mailbox.onMessage((from, message) => log.push({ from, message }));
  },
  mail: (id) => mailLogs.get(id) ?? [],
  async drive(id, port, path) {
    const preview = await get(id).openPreview(port, path ? { path } : {});
    const handle = nextPreview++;
    previews.set(handle, preview);
    return handle;
  },
  async previewCall(handle, method, ...args) {
    const preview = previews.get(handle) as unknown as Record<string, (...a: unknown[]) => unknown>;
    try {
      const value = await preview[method]!.call(preview, ...args);
      if (value instanceof Uint8Array) {
        let s = '';
        for (const b of value) s += String.fromCharCode(b);
        return { png: btoa(s) };
      }
      return value;
    } catch (err) {
      const e = err as { code?: unknown; message?: unknown };
      return { error: String(e.code ?? 'Error'), message: String(e.message) };
    }
  },
  networkLog: (id, since) => get(id).networkLog(since),
  async memory(id) {
    const bytes = await Promise.race([
      get(id).measureMemory(),
      new Promise<null>((r) => setTimeout(() => r(null), 30_000)),
    ]);
    return { instanceMB: bytes === null ? null : Math.round((bytes / 2 ** 20) * 10) / 10 };
  },
  async pipeThrough(id, cmd, args, chunks) {
    const proc = await get(id).spawn(cmd, args);
    let stdout = '';
    const done = drain(proc.stdout, (s) => (stdout += s));
    const writer = proc.stdin.getWriter();
    for (const c of chunks) await writer.write(new TextEncoder().encode(c));
    await writer.close();
    await done;
    return { stdout, code: (await proc.exit).code };
  },
  agent(id) {
    const handle = nextPreview++;
    agents.set(handle, createAgentTools({ instance: get(id), onSpawn: (child) => keep(child) }));
    return handle;
  },
  agentCall: (handle, tool, input) => agents.get(handle)!.call(tool, input),
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
