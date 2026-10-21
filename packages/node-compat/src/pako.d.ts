// SPDX-License-Identifier: Apache-2.0
// Minimal typings for the parts of pako 2.1 that `zlib` uses.
declare module 'pako' {
  interface StreamOptions {
    level?: number;
    windowBits?: number;
    memLevel?: number;
    strategy?: number;
    raw?: boolean;
    gzip?: boolean;
    chunkSize?: number;
    dictionary?: Uint8Array | ArrayBuffer | string;
  }
  class Engine {
    constructor(options?: StreamOptions);
    push(data: Uint8Array | ArrayBuffer, flushMode?: number | boolean): boolean;
    onData(chunk: Uint8Array): void;
    onEnd(status: number): void;
    err: number;
    msg: string;
    ended: boolean;
    strm: { avail_in: number; total_in: number; total_out: number };
  }
  export class Deflate extends Engine {}
  export class Inflate extends Engine {}
  const pako: { Deflate: typeof Deflate; Inflate: typeof Inflate };
  export default pako;
}
