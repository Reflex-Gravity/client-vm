// SPDX-License-Identifier: Apache-2.0
// Injected into HTML previews on port origins (next to the WebSocket shim).
// It records console output and lets the host drive the page: a DOM outline
// with element refs, clicks, typing, key presses, waits, evaluation and
// screenshots. The host connects by posting `clientvm:agent-connect` with a
// MessagePort from the parent window (docs/phase4-plan.md, slice 4d).
import { RpcEndpoint } from '@clientvm/protocol';
import type {
  ConsoleEntry,
  ConsoleLevel,
  DomSnapshot,
  PreviewAgentEvents,
  PreviewAgentRpc,
  PreviewTarget,
} from '@clientvm/protocol';

// ------------------------------------------------------------------ console

const MAX_ENTRIES = 500;
const MAX_TEXT = 4000;
const entries: ConsoleEntry[] = [];
let seq = 0;
let link: RpcEndpoint<PreviewAgentRpc, PreviewAgentEvents> | null = null;

function show(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
  try {
    const json = JSON.stringify(v);
    if (json !== undefined) return json;
  } catch {
    // circular or exotic
  }
  return String(v);
}

function record(level: ConsoleLevel, args: unknown[], time = Date.now()): void {
  let text = args.map(show).join(' ');
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}…`;
  const entry: ConsoleEntry = { seq: ++seq, level, text, time, url: location.href };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  link?.emit('console', [entry]);
}

type Captured = [ConsoleLevel, unknown[], number];
const early = (
  window as unknown as {
    __clientvmConsole?: { q: Captured[]; sink: ((e: Captured) => void) | null };
  }
).__clientvmConsole;
if (early) {
  // The inline capture script ran first; take over its buffer and stream.
  for (const [level, args, time] of early.q) record(level, args, time);
  early.q.length = 0;
  early.sink = ([level, args, time]) => record(level, args, time);
} else {
  // The inline script did not run (e.g. a CSP without 'unsafe-inline'): capture from here on.
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      record(level, args);
      original(...args);
    };
  }
  addEventListener('error', (e) =>
    record('error', [
      e.error instanceof Error ? e.error : `${e.message} (${e.filename}:${e.lineno})`,
    ]),
  );
  addEventListener('unhandledrejection', (e) =>
    record('error', ['Unhandled promise rejection:', e.reason]),
  );
}

// ------------------------------------------------------------------ outline

let refs = new Map<string, Element>();
let nextRef = 1;

function visible(el: Element): boolean {
  if (!(el instanceof HTMLElement || el instanceof SVGElement)) return true;
  if ((el as HTMLElement).hidden || el.getAttribute('aria-hidden') === 'true') return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return true;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK']);
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const quote = (s: string) => JSON.stringify(s.length > 200 ? `${s.slice(0, 200)}…` : s);

function labelOf(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return clean(aria);
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    const id = el.id;
    const label =
      (id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null) ?? el.closest('label');
    if (label) return clean(label.textContent ?? '');
    return el.getAttribute('placeholder') ?? el.getAttribute('name') ?? '';
  }
  if (el instanceof HTMLImageElement) return el.alt;
  return clean((el as HTMLElement).innerText ?? el.textContent ?? '');
}

/** A role and description for elements that get their own outline line, else null. */
function describe(el: Element): { role: string; text: string; interactive: boolean } | null {
  const tag = el.tagName;
  const role = el.getAttribute('role');
  if (/^H[1-6]$/.test(tag))
    return { role: `heading[${tag[1]}]`, text: labelOf(el), interactive: false };
  if (tag === 'A' && el.hasAttribute('href'))
    return { role: `link(${el.getAttribute('href')})`, text: labelOf(el), interactive: true };
  if (tag === 'BUTTON' || role === 'button')
    return { role: 'button', text: labelOf(el), interactive: true };
  if (el instanceof HTMLInputElement) {
    const type = el.type;
    if (type === 'hidden') return null;
    if (type === 'checkbox' || type === 'radio')
      return {
        role: `${type}${el.checked ? '(checked)' : ''}`,
        text: labelOf(el),
        interactive: true,
      };
    if (type === 'submit' || type === 'button' || type === 'reset')
      return { role: 'button', text: el.value, interactive: true };
    return {
      role: `textbox(${type})`,
      text: `${labelOf(el)} = ${quote(el.value)}`,
      interactive: true,
    };
  }
  if (el instanceof HTMLTextAreaElement)
    return { role: 'textbox', text: `${labelOf(el)} = ${quote(el.value)}`, interactive: true };
  if (el instanceof HTMLSelectElement)
    return {
      role: 'select',
      text: `${labelOf(el)} = ${quote(el.selectedOptions[0]?.textContent ?? '')}`,
      interactive: true,
    };
  if (tag === 'IMG') return { role: 'img', text: labelOf(el), interactive: false };
  if ((el as HTMLElement).isContentEditable && !el.parentElement?.isContentEditable)
    return { role: 'textbox(editable)', text: labelOf(el), interactive: true };
  if (role === 'link' || role === 'checkbox' || role === 'tab' || role === 'menuitem')
    return { role, text: labelOf(el), interactive: true };
  return null;
}

function outline(maxLength: number): { text: string; truncated: boolean } {
  refs = new Map();
  nextRef = 1;
  const lines: string[] = [];
  let length = 0;
  let truncated = false;
  const push = (depth: number, line: string) => {
    if (truncated) return;
    const s = `${'  '.repeat(depth)}- ${line}`;
    if (length + s.length > maxLength) {
      truncated = true;
      return;
    }
    lines.push(s);
    length += s.length + 1;
  };
  const walk = (node: Node, depth: number) => {
    if (truncated) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = clean(node.textContent ?? '');
      if (text) push(depth, `text ${quote(text)}`);
      return;
    }
    if (!(node instanceof Element) || SKIP.has(node.tagName) || !visible(node)) return;
    const d = describe(node);
    if (d) {
      let line = `${d.role} ${quote(d.text)}`;
      if (d.interactive) {
        const ref = `e${nextRef++}`;
        refs.set(ref, node);
        line += ` [ref=${ref}]`;
      }
      push(depth, line);
      // Headings, links and buttons already show their text.
      if (d.interactive || d.role.startsWith('heading') || node.tagName === 'IMG') return;
    }
    for (const child of node.childNodes) walk(child, d ? depth + 1 : depth);
  };
  if (document.body) walk(document.body, 0);
  return { text: lines.join('\n'), truncated };
}

// ------------------------------------------------------------------ targets

function findByText(text: string): Element | null {
  const wanted = clean(text).toLowerCase();
  const all = [...document.body.querySelectorAll('*')].filter(
    (el) => !SKIP.has(el.tagName) && visible(el),
  );
  const matches = all.filter((el) => labelOf(el).toLowerCase().includes(wanted));
  const interactive = matches.filter((el) => describe(el)?.interactive);
  const pool = interactive.length > 0 ? interactive : matches;
  // The innermost match is the most specific element.
  return pool.find((el) => !pool.some((other) => other !== el && el.contains(other))) ?? null;
}

function resolve(target: PreviewTarget): Element | null {
  if (typeof target !== 'object' || target === null) throw new Error('invalid target');
  if ('ref' in target)
    return refs.get(String(target.ref))?.isConnected ? refs.get(String(target.ref))! : null;
  if ('selector' in target) return document.querySelector(String(target.selector));
  if ('text' in target) return findByText(String(target.text));
  throw new Error('invalid target');
}

function need(target: PreviewTarget): HTMLElement {
  const el = resolve(target);
  if (!el) throw new Error(`no element matches ${JSON.stringify(target)}`);
  return el as HTMLElement;
}

// ------------------------------------------------------------------ input

function pointer(el: HTMLElement, type: string): void {
  const rect = el.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
    view: window,
  };
  el.dispatchEvent(
    type.startsWith('pointer')
      ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true })
      : new MouseEvent(type, init),
  );
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  // The prototype setter: frameworks (React) track the instance property.
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
}

const KEY_CODES: Record<string, string> = {
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'Backspace',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ' ': 'Space',
};

function press(key: string): void {
  const el = (document.activeElement as HTMLElement | null) ?? document.body;
  const init = {
    key,
    code: KEY_CODES[key] ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key),
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  const down = el.dispatchEvent(new KeyboardEvent('keydown', init));
  if (down && (key.length === 1 || key === 'Enter'))
    el.dispatchEvent(new KeyboardEvent('keypress', init));
  if (down) {
    if (key === 'Enter' && el instanceof HTMLInputElement && el.form) el.form.requestSubmit();
    else if (
      key === 'Enter' &&
      (el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement)
    )
      el.click();
    else if (key === 'Tab') {
      const focusable = [
        ...document.querySelectorAll<HTMLElement>(
          'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((f) => !(f as HTMLButtonElement).disabled && visible(f));
      const next = focusable[(focusable.indexOf(el) + 1) % Math.max(focusable.length, 1)];
      next?.focus();
    }
  }
  el.dispatchEvent(new KeyboardEvent('keyup', init));
}

// --------------------------------------------------------------- screenshot

async function screenshot(maxWidth: number): Promise<Uint8Array> {
  const width = document.documentElement.clientWidth || innerWidth;
  const height = innerHeight;
  const css = [...document.styleSheets]
    .map((sheet) => {
      try {
        return [...sheet.cssRules].map((r) => r.cssText).join('\n');
      } catch {
        return '';
      }
    })
    .join('\n');
  const clone = document.body.cloneNode(true) as HTMLElement;
  for (const s of clone.querySelectorAll('script, noscript')) s.remove();
  // Current form state lives in properties, not attributes.
  const live = document.body.querySelectorAll('input, textarea, select');
  clone.querySelectorAll('input, textarea, select').forEach((el, i) => {
    const src = live[i];
    if (src instanceof HTMLInputElement && el instanceof HTMLInputElement) {
      el.setAttribute('value', src.value);
      if (src.checked) el.setAttribute('checked', '');
    } else if (src instanceof HTMLTextAreaElement) {
      el.textContent = src.value;
    }
  });
  // Same-origin images become data URLs (an SVG image cannot load anything).
  const imgs = document.body.querySelectorAll('img');
  clone.querySelectorAll('img').forEach((img, i) => {
    const src = imgs[i];
    if (!src?.complete || !src.naturalWidth) return;
    try {
      const c = document.createElement('canvas');
      c.width = src.naturalWidth;
      c.height = src.naturalHeight;
      c.getContext('2d')!.drawImage(src, 0, 0);
      img.setAttribute('src', c.toDataURL());
    } catch {
      img.removeAttribute('src');
    }
  });
  const body = new XMLSerializer().serializeToString(clone);
  const bodyStyle = getComputedStyle(document.body);
  const htmlStyle = getComputedStyle(document.documentElement);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject x="0" y="${-scrollY}" width="${width}" height="${document.documentElement.scrollHeight}">` +
    `<html xmlns="http://www.w3.org/1999/xhtml" style="background:${htmlStyle.backgroundColor}">` +
    `<head><style>${css.replace(/]]>/g, '')}</style></head>` +
    body.replace(
      /^<body/,
      `<body style="margin:${bodyStyle.margin};background:${bodyStyle.backgroundColor}"`,
    ) +
    '</html></foreignObject></svg>';
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const scale = Math.min(1, maxWidth / width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle =
    htmlStyle.backgroundColor === 'rgba(0, 0, 0, 0)' ? '#fff' : htmlStyle.backgroundColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error('screenshot failed');
  return new Uint8Array(await blob.arrayBuffer());
}

// --------------------------------------------------------------------- rpc

const methods: PreviewAgentRpc = {
  snapshot(opts) {
    const maxLength =
      typeof opts?.maxLength === 'number' && opts.maxLength > 0 ? opts.maxLength : 20_000;
    const { text, truncated } = outline(maxLength);
    const snap: DomSnapshot = {
      url: location.href,
      title: document.title,
      outline: text,
      truncated,
    };
    if (opts?.html) snap.html = document.documentElement.outerHTML;
    return snap;
  },
  click(target) {
    const el = need(target);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    pointer(el, 'pointerdown');
    pointer(el, 'mousedown');
    el.focus({ preventScroll: true });
    pointer(el, 'pointerup');
    pointer(el, 'mouseup');
    el.click();
  },
  type(target, text, opts) {
    const el = need(target);
    el.focus();
    const value = String(text);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      setValue(el, opts?.clear ? value : el.value + value);
      el.dispatchEvent(
        new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }),
      );
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el instanceof HTMLSelectElement) {
      const option = [...el.options].find((o) => o.value === value || o.text === value);
      if (!option) throw new Error(`no option ${JSON.stringify(value)}`);
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      if (opts?.clear) el.textContent = '';
      document.execCommand('insertText', false, value);
    } else {
      throw new Error('the target is not a text field');
    }
    if (opts?.submit) press('Enter');
  },
  press(key) {
    press(String(key));
  },
  async waitFor(target, opts) {
    const deadline = Date.now() + Math.min(Math.max(opts?.timeoutMs ?? 5000, 0), 60_000);
    for (;;) {
      const el = resolve(target);
      const present = el !== null && visible(el);
      if (opts?.gone ? !present : present) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  },
  async evaluate(expression) {
    const value: unknown = await (0, eval)(String(expression));
    if (value === undefined) return null;
    return JSON.parse(JSON.stringify(value) ?? 'null') as unknown;
  },
  screenshot(opts) {
    return screenshot(
      typeof opts?.maxWidth === 'number' && opts.maxWidth > 0 ? opts.maxWidth : 1280,
    );
  },
};

addEventListener('message', (event) => {
  const data = event.data as { t?: unknown; v?: unknown } | null;
  if (event.source !== window.parent || data?.t !== 'clientvm:agent-connect' || data.v !== 1)
    return;
  const port = event.ports[0];
  if (!port) return;
  link = new RpcEndpoint<PreviewAgentRpc, PreviewAgentEvents>(port, methods);
  if (entries.length > 0) link.emit('console', entries.slice());
  link.emit('ready', location.href, document.title);
});
addEventListener('pagehide', () => link?.emit('leaving'));
