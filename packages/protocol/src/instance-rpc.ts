// SPDX-License-Identifier: Apache-2.0
import type { SyscallMode } from './process-messages.ts';

/**
 * Contract between the controller (host page, trusted) and an instance's
 * kernel worker (on the instance origin, which runs hostile code). The
 * controller must treat every value it receives as untrusted input.
 */

export type FileKind = 'file' | 'dir' | 'symlink';

export interface InstanceInit {
  /** Instance id, also the first DNS label of the instance origin. */
  id: string;
  limits?: { quotaBytes?: number; maxInodes?: number; maxProcesses?: number };
  /** Boot from a filesystem image (fork) instead of the default seed. */
  image?: Uint8Array[];
  /** Files to write after boot: path -> contents (directories are created). Ignored when restoring persisted state. */
  files?: Record<string, string | Uint8Array>;
  /**
   * Persist the filesystem to the instance origin's OPFS and restore it on
   * boot (reattach by passing the same id). Persisted state wins over `image`.
   */
  persist?: boolean;
}

export interface WireStat {
  type: FileKind;
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

export interface WireDirEntry {
  name: string;
  type: FileKind;
}

export type WireFsEvent =
  | { type: 'create' | 'modify' | 'delete'; path: string }
  | { type: 'rename'; from: string; to: string };

export type Signal = 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP' | 'SIGPIPE';

export interface SpawnRequest {
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
  syscallMode?: SyscallMode;
  /** For `run`: bytes written to stdin before it is closed. `spawn` keeps stdin open. */
  stdin?: string | Uint8Array;
  /** For `run`: send SIGTERM to the process (and its children) after this many milliseconds. */
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  signal: Signal | null;
  stdout: string;
  stderr: string;
  /** Milliseconds from spawn until the process runtime reported ready. */
  spawnToReadyMs: number | null;
  /** Milliseconds from spawn until exit, measured in the kernel. */
  totalMs: number;
}

/** Methods the instance kernel serves to the controller. */
export type InstanceRpc = {
  ping(): { crossOriginIsolated: boolean };
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array | string): void;
  readdir(path: string): WireDirEntry[];
  stat(path: string): WireStat;
  mkdir(path: string, recursive: boolean): void;
  rm(path: string, recursive: boolean, force: boolean): void;
  rename(from: string, to: string): void;
  symlink(target: string, path: string): void;
  watch(path: string, recursive: boolean): number;
  unwatch(watchId: number): void;
  /** Starts a process; output and exit arrive as {@link InstanceEvents}. Fails with EAGAIN at the process limit. */
  spawn(request: SpawnRequest): number;
  kill(pid: number, signal: Signal): void;
  /** Writes to a process's stdin; null closes it. Only for processes spawned with an open stdin. */
  writeStdin(pid: number, data: Uint8Array | null): void;
  /** Runs a process to completion, collecting its output (tests and benchmarks). */
  run(request: SpawnRequest): Promise<RunResult>;
  /** Takes a copy-on-write snapshot held by this kernel; returns its number. */
  snapshot(): number;
  dropSnapshot(snapshot: number): void;
  /** Serializes a snapshot (or the live tree when null) for forking into another origin. */
  exportImage(snapshot: number | null): Uint8Array[];
  usage(): { bytes: number; inodes: number; processes: number; persist: PersistInfo | null };
  /** Persists all changes so far (no-op when not persistent). */
  flush(): Promise<void>;
  /** Deletes the persisted store; the instance keeps running in memory only. */
  purge(): Promise<void>;
  /**
   * Serves `dir` as static files on a virtual port (the Phase 2 stand-in for
   * `http.createServer`). The first port opened becomes the primary port,
   * served at the instance origin's root.
   */
  serveStatic(port: number, dir: string): void;
  /**
   * Serves HTTP for one virtual port on `channel` (the other end belongs to
   * that port origin's service worker, via the controller's bridge page).
   */
  linkPort(port: number, channel: MessagePort): void;
  /** Kills all processes and flushes persisted state; the controller removes the iframe afterwards. */
  shutdown(): Promise<void>;
};

export interface PersistInfo {
  generation: number;
  flushes: number;
  lastFlushMs: number;
  bytesWritten: number;
  /** Whether the state was restored from storage at boot. */
  restored: boolean;
}

/** Events the instance kernel emits to the controller. */
export type InstanceEvents = {
  output(pid: number, fd: 1 | 2, data: Uint8Array): void;
  exit(pid: number, code: number, signal: Signal | null): void;
  fsEvents(watchId: number, events: WireFsEvent[]): void;
  /** A virtual port is accepting requests. The controller links a port origin to it. */
  portOpen(port: number, primary: boolean): void;
  /** A virtual port stopped listening. */
  portClose(port: number): void;
};

/** Messages exchanged between the controller and the instance page during the handshake. */
export type HandshakeMessage =
  | { t: 'clientvm:hello'; v: 1; crossOriginIsolated: boolean }
  | { t: 'clientvm:connect'; v: 1; init: InstanceInit };

export const SIGNAL_NUMBERS: Record<Signal, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGKILL: 9,
  SIGPIPE: 13,
  SIGTERM: 15,
};
