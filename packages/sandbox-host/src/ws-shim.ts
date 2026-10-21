// SPDX-License-Identifier: Apache-2.0
// Injected into HTML previews on port origins. Service workers cannot see
// WebSockets, so this replaces `WebSocket` for this origin (and localhost):
// it asks the service worker for a byte tunnel to the virtual server and
// speaks RFC 6455 over it. Other URLs use the browser's own WebSocket.
import type { ServiceWorkerMessage } from '@clientvm/protocol';

type Listener = ((this: WebSocket, ev: Event) => unknown) | null;

const NativeWebSocket = window.WebSocket;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function isTunnelled(url: URL): boolean {
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return false;
  return (
    url.hostname === location.hostname ||
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1'
  );
}

/** A client frame (always masked, as RFC 6455 requires). */
function frame(opcode: number, payload: Uint8Array): Uint8Array {
  const len = payload.length;
  const header = len < 126 ? 2 : len < 65536 ? 4 : 10;
  const out = new Uint8Array(header + 4 + len);
  out[0] = 0x80 | opcode;
  if (len < 126) out[1] = 0x80 | len;
  else if (len < 65536) {
    out[1] = 0x80 | 126;
    out[2] = len >> 8;
    out[3] = len & 0xff;
  } else {
    out[1] = 0x80 | 127;
    new DataView(out.buffer).setBigUint64(2, BigInt(len));
  }
  const mask = crypto.getRandomValues(new Uint8Array(4));
  out.set(mask, header);
  for (let i = 0; i < len; i++) out[header + 4 + i] = payload[i]! ^ mask[i & 3]!;
  return out;
}

class ClientVMWebSocket extends EventTarget {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;

  declare readonly url: string;
  readyState = CONNECTING;
  protocol = '';
  extensions = '';
  binaryType: BinaryType = 'blob';
  bufferedAmount = 0;
  onopen: Listener = null;
  onmessage: Listener = null;
  onerror: Listener = null;
  onclose: Listener = null;

  declare private readonly port: MessagePort;
  private buffer: Uint8Array = new Uint8Array(0);
  private handshakeDone = false;
  private fragments: Uint8Array[] = [];
  private fragmentOpcode = 0;
  private closeSent = false;
  private sendChain: Promise<void> = Promise.resolve();

  constructor(url: string | URL, protocols?: string | string[]) {
    super();
    const u = new URL(url, location.href);
    if (u.protocol === 'http:') u.protocol = 'ws:';
    if (u.protocol === 'https:') u.protocol = 'wss:';
    if (!isTunnelled(u) || !navigator.serviceWorker?.controller) {
      return new NativeWebSocket(url, protocols) as unknown as ClientVMWebSocket;
    }
    (this as { url: string }).url = u.href;
    const list = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const headers: [string, string][] = [
      ['host', location.host],
      ['upgrade', 'websocket'],
      ['connection', 'Upgrade'],
      ['sec-websocket-key', key],
      ['sec-websocket-version', '13'],
      ['origin', location.origin],
    ];
    if (list.length > 0) headers.push(['sec-websocket-protocol', list.join(', ')]);
    const channel = new MessageChannel();
    (this as unknown as { port: MessagePort }).port = channel.port1;
    this.port.onmessage = (e: MessageEvent<unknown>) => this.receive(e.data);
    const open: ServiceWorkerMessage = { t: 'clientvm:ws-open', url: this.url, headers };
    navigator.serviceWorker.controller.postMessage(open, [channel.port2]);
  }

  private fire(type: string, init?: Record<string, unknown>): void {
    let event: Event;
    if (type === 'message')
      event = new MessageEvent('message', {
        ...(init as MessageEventInit),
        origin: new URL(this.url).origin,
      });
    else if (type === 'close') event = new CloseEvent('close', init as CloseEventInit);
    else event = new Event(type);
    const handler = (this as unknown as Record<string, Listener>)[`on${type}`];
    if (typeof handler === 'function') handler.call(this as unknown as WebSocket, event);
    this.dispatchEvent(event);
  }

  private receive(data: unknown): void {
    if (data === null) {
      this.finish(this.handshakeDone ? 1006 : 1006, '', false);
      return;
    }
    if (!(data instanceof Uint8Array)) return;
    this.buffer = this.buffer.length > 0 ? concat(this.buffer, data) : data;
    if (!this.handshakeDone) {
      const text = decoder.decode(this.buffer.subarray(0, Math.min(this.buffer.length, 8192)));
      const end = text.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = text.slice(0, end).split('\r\n');
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? '');
      if (!status || status[1] !== '101') {
        this.port.postMessage(null);
        this.fire('error');
        this.finish(1006, '', false);
        return;
      }
      for (const line of head.slice(1)) {
        const i = line.indexOf(':');
        if (i > 0 && line.slice(0, i).trim().toLowerCase() === 'sec-websocket-protocol') {
          this.protocol = line.slice(i + 1).trim();
        }
      }
      this.buffer = this.buffer.subarray(encoder.encode(text.slice(0, end + 4)).length);
      this.handshakeDone = true;
      this.readyState = OPEN;
      this.fire('open');
    }
    this.parseFrames();
  }

  private parseFrames(): void {
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0]! & 0x80) !== 0;
      const opcode = b[0]! & 0x0f;
      const masked = (b[1]! & 0x80) !== 0;
      let len = b[1]! & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = (b[2]! << 8) | b[3]!;
        offset = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(new DataView(b.buffer, b.byteOffset + 2, 8).getBigUint64(0));
        offset = 10;
      }
      const maskKey = masked ? b.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (b.length < offset + len) return;
      const payload = b.slice(offset, offset + len);
      if (maskKey)
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ maskKey[i & 3]!;
      this.buffer = b.subarray(offset + len);
      this.onFrame(fin, opcode, payload);
      if (this.readyState === CLOSED) return;
    }
  }

  private onFrame(fin: boolean, opcode: number, payload: Uint8Array): void {
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? (payload[0]! << 8) | payload[1]! : 1005;
      const reason = payload.length > 2 ? decoder.decode(payload.subarray(2)) : '';
      if (!this.closeSent) this.writeFrame(0x8, payload.subarray(0, 2));
      this.port.postMessage(null);
      this.finish(code, reason, true);
      return;
    }
    if (opcode === 0x9) {
      this.writeFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) return;
    if (opcode === 0x0) this.fragments.push(payload);
    else {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
    }
    if (!fin) return;
    let whole = this.fragments.length === 1 ? this.fragments[0]! : this.fragments.reduce(concat);
    this.fragments = [];
    if (this.fragmentOpcode === 0x1) {
      this.fire('message', { data: decoder.decode(whole) });
    } else {
      whole = whole.slice();
      const data =
        this.binaryType === 'arraybuffer'
          ? whole.buffer
          : new Blob([whole as Uint8Array<ArrayBuffer>]);
      this.fire('message', { data });
    }
  }

  private writeFrame(opcode: number, payload: Uint8Array): void {
    this.port.postMessage(frame(opcode, payload));
  }

  private finish(code: number, reason: string, wasClean: boolean): void {
    if (this.readyState === CLOSED) return;
    const wasOpen = this.readyState !== CONNECTING;
    this.readyState = CLOSED;
    this.port.close();
    if (!wasClean && !wasOpen) this.fire('error');
    this.fire('close', { code, reason, wasClean });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState === CONNECTING) {
      throw new DOMException(
        "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
        'InvalidStateError',
      );
    }
    if (this.readyState !== OPEN) return;
    this.sendChain = this.sendChain.then(async () => {
      if (typeof data === 'string') this.writeFrame(0x1, encoder.encode(data));
      else if (data instanceof Blob) this.writeFrame(0x2, new Uint8Array(await data.arrayBuffer()));
      else if (ArrayBuffer.isView(data))
        this.writeFrame(0x2, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      else this.writeFrame(0x2, new Uint8Array(data));
    });
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    if (this.readyState === CONNECTING) {
      this.port.postMessage(null);
      this.finish(1006, '', false);
      return;
    }
    this.readyState = CLOSING;
    const r = encoder.encode(reason);
    const payload = new Uint8Array(2 + r.length);
    payload[0] = code >> 8;
    payload[1] = code & 0xff;
    payload.set(r, 2);
    this.closeSent = true;
    this.sendChain = this.sendChain.then(() => this.writeFrame(0x8, payload));
  }
}

Object.defineProperty(window, 'WebSocket', {
  value: ClientVMWebSocket,
  writable: true,
  configurable: true,
});
