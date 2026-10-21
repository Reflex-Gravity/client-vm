// SPDX-License-Identifier: Apache-2.0

/**
 * Public ClientVM API (Phase 0 draft, refined from CLAUDE.md section 6).
 * Types only: implementations land in Phases 2-4. See docs/interfaces.md.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type InstanceId = Brand<string, 'InstanceId'>;
export type InstanceName = string;
export type SnapshotId = Brand<string, 'SnapshotId'>;

export interface Disposable {
  dispose(): void;
}

export type Signal = 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP';

/** Process tiers. Only `js` and `builtin` exist in v1; the others are reserved. */
export type ProcessType = 'js' | 'builtin' | 'wasi' | 'vm';

/** Inline file contents used to seed an instance. Directories are nested trees. */
export interface FileTree {
  [name: string]: string | Uint8Array | FileTree;
}

export interface Limits {
  maxProcesses?: number;
  maxMemoryMB?: number;
  /** Total bytes the instance's filesystem may hold. */
  quotaBytes?: number;
  /** CPU time budget per process, in milliseconds. */
  maxCpuMs?: number;
}

export type Capability =
  | { kind: 'mount'; from: InstanceId; path: string; readOnly: boolean }
  | { kind: 'channel'; peer: InstanceId }
  | { kind: 'net'; peer: InstanceId; ports?: number[] }
  | { kind: 'spawn-instance'; limits?: Limits };

export interface InstanceOptions {
  /**
   * Instance id (a DNS label). Defaults to a random 16-character id. Pass an
   * existing id to reattach to a persisted instance's storage.
   */
  id?: string;
  name?: InstanceName;
  parent?: InstanceId;
  fs?: {
    from?: SnapshotId | FileTree;
    quotaBytes?: number;
    /**
     * Persist the filesystem in the instance origin's OPFS (write-behind) and
     * restore it when an instance with the same `id` is created again. Writes
     * after the last flush may be lost on a crash; `Instance.flush()` is the
     * durability point. One tab at a time may open a persistent instance.
     */
    persist?: boolean;
  };
  limits?: Omit<Limits, 'quotaBytes'>;
  capabilities?: Capability[];
}

export interface InstanceInfo {
  id: InstanceId;
  name?: InstanceName;
  parent?: InstanceId;
  origin: string;
  processCount: number;
  createdAt: number;
}

export interface ClientVM {
  createInstance(opts?: InstanceOptions): Promise<Instance>;
  getInstance(id: InstanceId): Instance | undefined;
  listInstances(): InstanceInfo[];
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  type?: ProcessType;
}

export interface ExecOptions extends Omit<SpawnOptions, 'type'> {
  /** Kill the command after this many milliseconds. */
  timeoutMs?: number;
  stdin?: string | Uint8Array;
}

export interface ExecResult {
  code: number;
  signal?: Signal;
  stdout: string;
  stderr: string;
}

export interface Instance {
  readonly id: InstanceId;
  /** Per-instance sandbox origin, e.g. https://<id>.sandbox.example.dev */
  readonly origin: string;
  readonly fs: FileSystem;
  readonly mailbox: Mailbox;
  spawn(cmd: string, args?: string[], opts?: SpawnOptions): Promise<Process>;
  /** Runs a command line through the shell. */
  exec(commandLine: string, opts?: ExecOptions): Promise<ExecResult>;
  onPortOpen(cb: (port: number, url: string) => void): Disposable;
  snapshot(): Promise<SnapshotId>;
  fork(opts?: InstanceOptions): Promise<Instance>;
  grant(to: InstanceId, cap: Capability): Promise<void>;
  /** Persists pending filesystem changes. Resolves immediately for non-persistent instances. */
  flush(): Promise<void>;
  /**
   * Stops all processes and removes the instance. Persistent instances flush
   * first and keep their stored data unless `purge` is set.
   */
  destroy(opts?: { purge?: boolean }): Promise<void>;
}

export interface Process {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(signal?: Signal): void;
  readonly exit: Promise<{ code: number; signal?: Signal }>;
}

export type FileType = 'file' | 'dir' | 'symlink';

export interface DirEntry {
  name: string;
  type: FileType;
}

export interface Stat {
  type: FileType;
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

export type FsEvent =
  | { type: 'create' | 'modify' | 'delete'; path: string }
  | { type: 'rename'; from: string; to: string };

export type MountSource =
  | { kind: 'instance'; from: InstanceId; path: string; readOnly: boolean }
  | { kind: 'snapshot'; snapshot: SnapshotId; readOnly: true };

export interface FileSystem {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  readdir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<Stat>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  watch(path: string, cb: (e: FsEvent) => void): Disposable;
  /** Requires a matching `mount` capability. */
  mount(path: string, source: MountSource): Promise<void>;
}

export interface Mailbox {
  send(to: InstanceName | InstanceId, msg: unknown): Promise<void>;
  onMessage(cb: (from: InstanceId, msg: unknown) => void): Disposable;
}
