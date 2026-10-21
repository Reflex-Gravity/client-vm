// SPDX-License-Identifier: Apache-2.0
// `v8`: heap statistics from Chromium's performance.memory where present,
// serialize/deserialize over JSON, no heap snapshots.

import { Buffer } from './buffer.ts';

interface PerfMemory {
  jsHeapSizeLimit: number;
  totalJSHeapSize: number;
  usedJSHeapSize: number;
}

function memory(): PerfMemory {
  const m = (performance as unknown as { memory?: PerfMemory }).memory;
  return m ?? { jsHeapSizeLimit: 4345298944, totalJSHeapSize: 0, usedJSHeapSize: 0 };
}

const unsupported = (what: string) => () => {
  const err = new Error(`${what} is not available in ClientVM yet (see docs/compatibility.md)`);
  (err as { code?: string }).code = 'ERR_CLIENTVM_UNSUPPORTED';
  throw err;
};

export function createV8(): Record<string, unknown> {
  return {
    getHeapStatistics: () => {
      const m = memory();
      return {
        total_heap_size: m.totalJSHeapSize,
        total_heap_size_executable: 0,
        total_physical_size: m.totalJSHeapSize,
        total_available_size: m.jsHeapSizeLimit - m.usedJSHeapSize,
        used_heap_size: m.usedJSHeapSize,
        heap_size_limit: m.jsHeapSizeLimit,
        malloced_memory: 0,
        peak_malloced_memory: 0,
        does_zap_garbage: 0,
        number_of_native_contexts: 1,
        number_of_detached_contexts: 0,
        total_global_handles_size: 0,
        used_global_handles_size: 0,
        external_memory: 0,
      };
    },
    getHeapSpaceStatistics: () => [],
    getHeapCodeStatistics: () => ({
      code_and_metadata_size: 0,
      bytecode_and_metadata_size: 0,
      external_script_source_size: 0,
      cpu_profiler_metadata_size: 0,
    }),
    cachedDataVersionTag: () => 0,
    setFlagsFromString: () => {},
    setHeapSnapshotNearHeapLimit: () => {},
    isStringOneByteRepresentation: (s: string) => [...s].every((c) => c.charCodeAt(0) <= 0xff),
    // Not V8's wire format: values round-trip through ClientVM's own encoding only.
    serialize: (value: unknown) => Buffer.from(JSON.stringify(value) ?? 'null'),
    deserialize: (buf: Uint8Array) => JSON.parse(new TextDecoder().decode(buf)) as unknown,
    getHeapSnapshot: unsupported('v8.getHeapSnapshot'),
    writeHeapSnapshot: unsupported('v8.writeHeapSnapshot'),
  };
}
