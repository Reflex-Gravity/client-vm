// SPDX-License-Identifier: Apache-2.0
// The demos, in two halves. `Demo` is the light half, in ./catalog.ts: copy,
// setup steps and "try" chips, which pages draw at build time and the demo's
// small entry script reads in the browser. `DemoDefinition` is the heavy half,
// one module per demo in this folder: the project's files and how it starts,
// imported only when a visitor runs that demo (../demo/run.ts).

/** The steps the progress strip walks through, in order. */
export type SetupStep = 'boot' | 'install' | 'start' | 'ready';

/** A "try" chip: types a shell command, or makes one agent tool call. */
export interface Trigger {
  label: string;
  /** Typed into the terminal's bash. */
  command?: string;
  /** Called through @clientvm/agent-api, as a model's tool call would be. */
  tool?: { name: string; input: Record<string, unknown> };
}

export type DemoCategory = 'Frameworks' | 'Servers' | 'Shell & tools' | 'Agents';

export interface Demo {
  /** The URL segment, /demos/<slug>/, and the module name, ./<slug>.ts. */
  slug: string;
  /** The picker's and the card's title. */
  name: string;
  /** A few words under the name in the picker. */
  tag: string;
  /** One sentence, on the card and as the page's description. */
  summary: string;
  category: DemoCategory;
  /** The tools on show, as chips. */
  builtWith: string[];
  /** The start button's label. */
  start: string;
  /** The steps it goes through; `boot` first, `ready` last. */
  steps: SetupStep[];
  /** What the empty preview says while it runs. */
  previewHint: string;
  /** Commands the "try" chips type into the terminal. */
  triggers: Trigger[];
  /** Paragraphs for the demo's page: what it shows. */
  about: string[];
  /** The ClientVM calls it makes, for "How it's built". */
  code: string;
  /** Where its files live in the repository, for "View source". */
  source: string;
  /** Docs pages it shows off, as `doc()` slugs with a label. */
  docs: { label: string; slug: string }[];
}

export interface DemoDefinition {
  /** Boot from a ready project (ADR 0018); `files` are then written over it. */
  preset?: 'vite-react-ts';
  /** The project, relative to the app directory. */
  files: Record<string, string>;
  /** The files the editor opens, relative to the app directory; the first is shown. */
  editable: string[];
  /** What the terminal says while the instance boots. */
  bootNote: string;
  /** Lines shown, in green, before the first prompt. */
  welcome?: string[];
  /**
   * Typed after `npm install`, once bash prompts. Without it nothing is
   * installed and the demo is ready at the first prompt.
   */
  start?: string;
  /** Run `npm install` before `start` (default true). */
  install?: boolean;
  /**
   * `start` is a background job (it ends in `&`): install in the foreground,
   * then start it, so bash prompts again and the chips can reach the server.
   */
  background?: boolean;
  /** Matches the argv of the server `start` spawns, so the strip can show "start". */
  serverProcess?: RegExp;
  /**
   * A server without a file watcher: when `file` changes, the runner presses
   * Ctrl+C and types `command` again.
   */
  restartOn?: { file: string; command: string };
  /**
   * The chips call agent tools, and the agent's preview of the app replaces
   * the plain one, so a visitor sees what the agent clicks and types.
   */
  agentTools?: boolean;
}
