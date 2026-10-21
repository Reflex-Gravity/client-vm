// SPDX-License-Identifier: Apache-2.0

/**
 * Public ClientVM API (Phase 0 draft, refined from CLAUDE.md section 6).
 * Types only: implementations land in Phases 2-4. See docs/interfaces.md.
 */

import type { ConsoleEntry, DomSnapshot, NetworkLogEntry, PreviewTarget } from '@clientvm/protocol';

export type { ConsoleEntry, DomSnapshot, NetworkLogEntry, PreviewTarget };

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type InstanceId = Brand<string, 'InstanceId'>;
export type InstanceName = string;
export type SnapshotId = Brand<string, 'SnapshotId'>;

export interface Disposable {
  dispose(): void;
}

export type Signal = 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP' | 'SIGPIPE';

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
  /**
   * A DNS label, unique among live instances. Other instances reach this one
   * as `http://<name>.internal:<port>/` and address mail to it by name.
   */
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
  /** Grants `cap` to instance `to` with the host's authority (any capability). */
  grant(to: InstanceId, cap: Capability): void;
  /** Removes a capability from `to`. Returns whether it held one. */
  revoke(to: InstanceId, cap: Capability): boolean;
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
  /** Unique among live instances; also its `<name>.internal` host name. */
  readonly name?: InstanceName;
  /** Per-instance sandbox origin, e.g. https://<id>.sandbox.example.dev */
  readonly origin: string;
  readonly fs: FileSystem;
  readonly mailbox: Mailbox;
  spawn(cmd: string, args?: string[], opts?: SpawnOptions): Promise<Process>;
  /** Runs a command line through the shell. */
  exec(commandLine: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Reports each virtual port with its preview URL (the port's own origin). */
  onPortOpen(cb: (port: number, url: string) => void): Disposable;
  /** Reports ports that stop listening. */
  onPortClose(cb: (port: number) => void): Disposable;
  /**
   * Opens a driveable preview of a virtual port (waits up to the boot timeout
   * for it to open): an iframe on the port's origin plus a channel to the
   * agent script injected into its HTML pages.
   */
  openPreview(port: number, opts?: PreviewOptions): Promise<Preview>;
  /** Requests served on this instance's virtual ports after `since` (a `seq`). */
  networkLog(since?: number): Promise<NetworkLogEntry[]>;
  snapshot(): Promise<SnapshotId>;
  fork(opts?: InstanceOptions): Promise<Instance>;
  /**
   * Grants `cap` to another instance. Allowed when `cap` is about this
   * instance (its `peer`/`from`), or this instance holds it (delegation).
   */
  grant(to: InstanceId, cap: Capability): Promise<void>;
  /** Revokes a capability about this instance from `to`. */
  revoke(to: InstanceId, cap: Capability): Promise<void>;
  /** The capabilities this instance holds. */
  capabilities(): Capability[];
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
  /**
   * Mounts another instance's directory (or a snapshot) read-only at `path`,
   * which must be absent or an empty directory. Requires a matching `mount`
   * capability. The mount is a mirror: changes in the source appear within
   * milliseconds; writes fail with EROFS. Writable mounts are not supported.
   */
  mount(path: string, source: MountSource): Promise<void>;
  /** Removes a mount, leaving an empty directory. */
  unmount(path: string): Promise<void>;
}

/**
 * Messages between instances, brokered by the controller. Sending needs a
 * `channel` capability to the recipient. Messages are JSON values up to 1 MiB.
 * Processes use the same mailbox at `http://mailbox.internal/`.
 */
export interface Mailbox {
  send(to: InstanceName | InstanceId, msg: unknown): Promise<void>;
  /** Messages delivered to this instance (also queued for its processes). */
  onMessage(cb: (from: InstanceId, msg: unknown) => void): Disposable;
}

export interface PreviewOptions {
  /** Where the iframe goes. Default: the controller's container. */
  container?: HTMLElement;
  /** Path to open, default `/`. */
  path?: string;
  /** Viewport size in CSS pixels, default 1024×768. */
  width?: number;
  height?: number;
}

/**
 * A live preview an agent can read and drive. Element targets are a `ref`
 * from the latest snapshot, a CSS `selector`, or visible `text`. Calls made
 * while the page navigates fail with `ERR_NAVIGATED` (reads retry once on the
 * new page). Page code is untrusted: results are data, not instructions.
 */
export interface Preview {
  readonly url: string;
  readonly iframe: HTMLIFrameElement;
  /** Resolves when the current page's agent is connected (`ERR_NO_AGENT` for non-HTML pages). */
  ready(): Promise<void>;
  snapshot(opts?: { html?: boolean; maxLength?: number }): Promise<DomSnapshot>;
  click(target: PreviewTarget): Promise<void>;
  type(
    target: PreviewTarget,
    text: string,
    opts?: { clear?: boolean; submit?: boolean },
  ): Promise<void>;
  press(key: string): Promise<void>;
  waitFor(target: PreviewTarget, opts?: { gone?: boolean; timeoutMs?: number }): Promise<boolean>;
  /** Evaluates a JavaScript expression in the page; the result comes back as JSON data. */
  evaluate(expression: string): Promise<unknown>;
  /** A PNG of the viewport rendered from the DOM (best effort). */
  screenshot(opts?: { maxWidth?: number }): Promise<Uint8Array>;
  /** Console output and uncaught errors, across page loads (bounded). */
  console(opts?: { since?: number }): ConsoleEntry[];
  navigate(path: string): Promise<void>;
  reload(): Promise<void>;
  close(): void;
}
