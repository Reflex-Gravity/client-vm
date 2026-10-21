// SPDX-License-Identifier: Apache-2.0
// The host side of the driveable preview (docs/phase4-plan.md, slice 4d): an
// iframe on a port origin plus a channel to the agent script the service
// worker injects into its HTML. Everything the agent sends is validated.
import { RpcEndpoint } from '@clientvm/protocol';
import type {
  ConsoleEntry,
  DomSnapshot,
  PreviewAgentEvents,
  PreviewAgentRpc,
  PreviewConnect,
  PreviewTarget,
} from '@clientvm/protocol';
import { ClientVMError } from './errors.ts';
import type { Preview } from './types.ts';

const AGENT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_CONSOLE = 1000;
const LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug']);

type Agent = RpcEndpoint<PreviewAgentEvents, PreviewAgentRpc>;

interface Connection {
  agent: Agent | null;
  ready: Promise<Agent>;
  /** Rejects when the page goes away, so calls on it fail instead of hanging. */
  gone: Promise<never>;
}

function noAgent(): ClientVMError {
  return new ClientVMError(
    'the preview has no ClientVM agent (it is not an HTML page served by the instance)',
    'ERR_NO_AGENT',
  );
}

export class PreviewImpl implements Preview {
  readonly url: string;
  readonly iframe: HTMLIFrameElement;
  private readonly origin: string;
  private conn!: Connection;
  private settle?: { resolve(a: Agent): void; reject(e: unknown): void; leave(e: unknown): void };
  private readonly logs: ConsoleEntry[] = [];
  private nextSeq = 1;
  private closed = false;
  private agentTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(url: string, container: HTMLElement, opts: { width?: number; height?: number } = {}) {
    this.url = url;
    this.origin = new URL(url).origin;
    this.iframe = document.createElement('iframe');
    this.iframe.className = 'clientvm-preview';
    this.iframe.style.width = `${opts.width ?? 1024}px`;
    this.iframe.style.height = `${opts.height ?? 768}px`;
    this.iframe.style.border = '0';
    this.arm();
    this.iframe.addEventListener('load', () => this.connect());
    this.iframe.src = url;
    container.append(this.iframe);
  }

  /** A fresh connection slot for the next page load. */
  private arm(): void {
    // Calls still waiting on the previous page fail rather than hang.
    this.settle?.leave(new ClientVMError('the preview navigated', 'ERR_NAVIGATED'));
    let resolve!: (a: Agent) => void;
    let reject!: (e: unknown) => void;
    let leave!: (e: unknown) => void;
    const ready = new Promise<Agent>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const gone = new Promise<never>((_res, rej) => {
      leave = rej;
    });
    ready.catch(() => {});
    gone.catch(() => {});
    this.conn = { agent: null, ready, gone };
    this.settle = { resolve, reject, leave };
  }

  private connect(): void {
    if (this.closed) return;
    // A load without a preceding `leaving` (e.g. a navigation the agent missed).
    if (this.conn.agent) this.arm();
    const conn = this.conn;
    const settle = this.settle!;
    const channel = new MessageChannel();
    const agent: Agent = new RpcEndpoint<PreviewAgentEvents, PreviewAgentRpc>(channel.port1, {
      ready: () => {
        if (this.conn !== conn) return;
        clearTimeout(this.agentTimer);
        conn.agent = agent;
        settle.resolve(agent);
      },
      leaving: () => {
        if (this.conn !== conn) return;
        this.arm();
      },
      console: (entries) => {
        if (!Array.isArray(entries)) return;
        for (const e of entries as Partial<ConsoleEntry>[]) {
          if (
            typeof e !== 'object' ||
            e === null ||
            !LEVELS.has(e.level as string) ||
            typeof e.text !== 'string' ||
            typeof e.time !== 'number'
          )
            continue;
          this.logs.push({
            seq: this.nextSeq++,
            level: e.level!,
            text: e.text.slice(0, 10_000),
            time: e.time,
            url: typeof e.url === 'string' ? e.url : '',
          });
        }
        if (this.logs.length > MAX_CONSOLE) this.logs.splice(0, this.logs.length - MAX_CONSOLE);
      },
    });
    const hello: PreviewConnect = { t: 'clientvm:agent-connect', v: 1 };
    this.iframe.contentWindow?.postMessage(hello, this.origin, [channel.port2]);
    clearTimeout(this.agentTimer);
    this.agentTimer = setTimeout(() => {
      if (this.conn === conn && !conn.agent) settle.reject(noAgent());
    }, AGENT_TIMEOUT_MS);
  }

  /** Resolves when the current page's agent is connected. */
  async ready(): Promise<void> {
    await this.conn.ready;
  }

  private async call<K extends keyof PreviewAgentRpc & string>(
    method: K,
    retry: boolean,
    ...args: Parameters<PreviewAgentRpc[K]>
  ): Promise<Awaited<ReturnType<PreviewAgentRpc[K]>>> {
    if (this.closed) throw new ClientVMError('the preview was closed', 'ERR_DESTROYED');
    const conn = this.conn;
    const agent = await conn.ready;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_r, reject) => {
      timer = setTimeout(
        () => reject(new ClientVMError(`preview ${method} timed out`, 'ERR_TIMEOUT')),
        CALL_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([agent.call(method, ...args), conn.gone, timeout]);
    } catch (err) {
      // Reads are safe to repeat on the page that replaced this one.
      if (retry && (err as { code?: unknown }).code === 'ERR_NAVIGATED')
        return this.call(method, false, ...args);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async snapshot(opts: { html?: boolean; maxLength?: number } = {}): Promise<DomSnapshot> {
    const s = (await this.call('snapshot', true, opts)) as Partial<DomSnapshot> | null;
    if (
      typeof s !== 'object' ||
      s === null ||
      typeof s.url !== 'string' ||
      typeof s.title !== 'string' ||
      typeof s.outline !== 'string'
    ) {
      throw new ClientVMError('preview sent a malformed snapshot', 'ERR_INSTANCE_PROTOCOL');
    }
    return {
      url: s.url,
      title: s.title,
      outline: s.outline,
      truncated: s.truncated === true,
      ...(typeof s.html === 'string' ? { html: s.html } : {}),
    };
  }

  async click(target: PreviewTarget): Promise<void> {
    await this.call('click', false, target);
  }

  async type(
    target: PreviewTarget,
    text: string,
    opts: { clear?: boolean; submit?: boolean } = {},
  ): Promise<void> {
    await this.call('type', false, target, text, opts);
  }

  async press(key: string): Promise<void> {
    await this.call('press', false, key);
  }

  async waitFor(
    target: PreviewTarget,
    opts: { gone?: boolean; timeoutMs?: number } = {},
  ): Promise<boolean> {
    return (await this.call('waitFor', true, target, opts)) === true;
  }

  evaluate(expression: string): Promise<unknown> {
    return this.call('evaluate', false, expression);
  }

  async screenshot(opts: { maxWidth?: number } = {}): Promise<Uint8Array> {
    const png = await this.call('screenshot', true, opts);
    if (!(png instanceof Uint8Array))
      throw new ClientVMError('preview sent a malformed screenshot', 'ERR_INSTANCE_PROTOCOL');
    return png;
  }

  console(opts: { since?: number } = {}): ConsoleEntry[] {
    const since = opts.since ?? 0;
    return this.logs.filter((e) => e.seq > since);
  }

  async navigate(path: string): Promise<void> {
    const target = new URL(path, this.url);
    if (target.origin !== this.origin)
      throw new ClientVMError(
        'previews can only navigate within their port origin',
        'ERR_INVALID_PATH',
      );
    this.arm();
    this.iframe.src = target.href;
    await this.ready();
  }

  reload(): Promise<void> {
    return this.navigate(this.iframe.src);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.agentTimer);
    this.settle?.reject(new ClientVMError('the preview was closed', 'ERR_DESTROYED'));
    this.settle?.leave(new ClientVMError('the preview was closed', 'ERR_DESTROYED'));
    this.iframe.remove();
  }
}
