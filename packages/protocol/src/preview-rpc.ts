// SPDX-License-Identifier: Apache-2.0
// The driveable preview (docs/phase4-plan.md, slice 4d). The port-origin
// service worker injects a small agent script into preview pages; the host
// connects to it with a MessageChannel and drives the page. Everything the
// agent sends comes from a page running instance code: hosts must treat it as
// untrusted data.

/** Where the agent script is served on port origins. */
export const PREVIEW_AGENT_PATH = '/__clientvm/agent.js';

/** Sent by the host to the preview window with the channel port. */
export interface PreviewConnect {
  t: 'clientvm:agent-connect';
  v: 1;
}

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface ConsoleEntry {
  /** Increasing per page load. */
  seq: number;
  level: ConsoleLevel;
  text: string;
  /** Milliseconds since the epoch. */
  time: number;
  /** The page that logged it. */
  url: string;
}

export interface DomSnapshot {
  url: string;
  title: string;
  /**
   * A text outline of what is visible: headings, text, links, buttons and
   * form fields, one per line and indented by nesting. Interactive elements
   * carry `[ref=eN]` for use as a target until the next snapshot.
   */
  outline: string;
  /** `document.documentElement.outerHTML`, when requested. */
  html?: string;
  /** True when the outline was cut at `maxLength`. */
  truncated: boolean;
}

/** How a command picks an element. `text` matches visible text (interactive elements first). */
export type PreviewTarget = { ref: string } | { selector: string } | { text: string };

export type PreviewAgentRpc = {
  snapshot(opts: { html?: boolean; maxLength?: number }): DomSnapshot;
  click(target: PreviewTarget): void;
  /** Sets a field's value as typing would (input and change events), optionally submitting. */
  type(target: PreviewTarget, text: string, opts: { clear?: boolean; submit?: boolean }): void;
  /** Dispatches a key press on the focused element (`Enter`, `Tab`, `Escape`, `a`, ...). */
  press(key: string): void;
  /** Resolves true once the target exists and is visible (or is gone, with `gone`), false on timeout. */
  waitFor(target: PreviewTarget, opts: { gone?: boolean; timeoutMs?: number }): Promise<boolean>;
  /** Evaluates an expression in the page; the result is returned as JSON data. */
  evaluate(expression: string): Promise<unknown>;
  /** A PNG of the viewport, rendered from the DOM (best effort: cross-origin images are blank). */
  screenshot(opts: { maxWidth?: number }): Promise<Uint8Array>;
};

export type PreviewAgentEvents = {
  /** The agent is connected; sent on every page load. */
  ready(url: string, title: string): void;
  /** The page is unloading (navigation or reload); a new agent will connect after load. */
  leaving(): void;
  console(entries: ConsoleEntry[]): void;
};

/** One request served on a virtual port, for the network log. */
export interface NetworkLogEntry {
  seq: number;
  /** Milliseconds since the epoch. */
  time: number;
  port: number | null;
  method: string;
  path: string;
  status: number;
  /** Milliseconds until the response headers were ready. */
  durationMs: number;
  /** The requesting instance, for requests from other instances. */
  from?: string;
}
