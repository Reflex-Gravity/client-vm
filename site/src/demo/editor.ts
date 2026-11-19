// SPDX-License-Identifier: Apache-2.0
// The demo's code editor (markup in components/Demo.astro): file tabs over a
// textarea laid on a highlighted <pre>. Edits are written to the instance's
// filesystem as you type, so Vite hot-reloads them and the Express server
// restarts (src/demo/run.ts). Each open file is watched, so changes made from
// the shell show up here too. No dependencies; file text is only ever
// rendered as escaped text (./highlight.ts).
import type { Disposable, FileSystem } from '@clientvm/clientvm';
import { highlight, langOf } from './highlight.ts';

const SAVE_DELAY_MS = 300;
const INDENT = '  ';

interface Buffer {
  path: string;
  text: string;
  /** A save is scheduled or in flight; changes on disk do not overwrite it. */
  pending: boolean;
  timer?: ReturnType<typeof setTimeout>;
  watch?: Disposable;
  tab: HTMLButtonElement;
}

export interface Editor {
  /** Opens `files` (relative to `dir`); the first is shown. Missing files are skipped. */
  open(fs: FileSystem, dir: string, files: string[]): Promise<void>;
  /** Opens one more file (relative to the open directory) and shows it. */
  add(path: string): Promise<void>;
  /** Closes a file's tab, after it was deleted. */
  forget(path: string): void;
  /** Follows a rename: the tab keeps its text under the new path. */
  renamed(from: string, to: string): void;
  /** The visitor edited a file since it opened. */
  readonly edited: boolean;
  clear(): void;
}

export function createEditor(root: HTMLElement, onState: (text: string) => void): Editor {
  const q = <T extends HTMLElement>(name: string) =>
    root.querySelector<T>(`[data-editor-${name}]`)!;
  const tabs = q('tabs');
  const code = q('code');
  const gutter = q('gutter');
  const hl = q('hl');
  const input = q<HTMLTextAreaElement>('input');
  const empty = q('empty');

  let buffers: Buffer[] = [];
  let active: Buffer | undefined;
  let fs: FileSystem | undefined;
  let dir = '';
  /** Bumped by clear(), so a stale read or save cannot touch the editor. */
  let gen = 0;
  let lines = 0;
  let edited = false;
  /** After Escape, Tab moves focus out of the editor instead of indenting. */
  let tabMovesFocus = false;
  const decoder = new TextDecoder();

  const full = (path: string) => `${dir}/${path}`;

  const render = () => {
    const text = active?.text ?? '';
    // The trailing newline keeps a last empty line as tall as the textarea's.
    hl.innerHTML = highlight(text, langOf(active?.path ?? '')) + '\n';
    const count = text.split('\n').length;
    if (count !== lines) {
      lines = count;
      gutter.textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n');
    }
    syncScroll();
  };

  const syncScroll = () => {
    hl.style.transform = `translate(${-input.scrollLeft}px, ${-input.scrollTop}px)`;
    gutter.style.transform = `translateY(${-input.scrollTop}px)`;
  };

  const show = (buf: Buffer) => {
    active = buf;
    for (const b of buffers) b.tab.setAttribute('aria-selected', String(b === buf));
    input.value = buf.text;
    input.setAttribute('aria-label', `Edit ${buf.path}`);
    input.scrollTop = 0;
    input.scrollLeft = 0;
    render();
  };

  const save = async (buf: Buffer) => {
    const g = gen;
    buf.timer = undefined;
    onState('saving…');
    try {
      await fs!.writeFile(full(buf.path), buf.text);
      if (g === gen && !buf.timer) onState(`saved ${buf.path}`);
    } catch (err) {
      if (g === gen) onState(`save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (!buf.timer) buf.pending = false;
    }
  };

  /** Picks up a change made outside the editor (the shell, npm). */
  const reload = async (buf: Buffer) => {
    const g = gen;
    if (buf.pending) return;
    let text: string;
    try {
      text = decoder.decode(await fs!.readFile(full(buf.path)));
    } catch {
      return; // deleted or mid-rename; keep what is shown
    }
    if (g !== gen || buf.pending || text === buf.text) return;
    buf.text = text;
    if (buf === active) {
      const { selectionStart, selectionEnd } = input;
      input.value = text;
      input.setSelectionRange(selectionStart, selectionEnd);
      render();
    }
    onState(`${buf.path} changed on disk`);
  };

  /** Inserts text at the caret through the browser's editing, so undo still works. */
  const insert = (text: string) => {
    if (!document.execCommand('insertText', false, text)) {
      input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
      input.dispatchEvent(new Event('input'));
    }
  };

  input.addEventListener('input', () => {
    const buf = active;
    if (!buf || !fs) return;
    buf.text = input.value;
    buf.pending = true;
    edited = true;
    clearTimeout(buf.timer);
    buf.timer = setTimeout(() => void save(buf), SAVE_DELAY_MS);
    onState('edited');
    render();
  });
  input.addEventListener('scroll', syncScroll);
  input.addEventListener('blur', () => (tabMovesFocus = false));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      tabMovesFocus = true;
      return;
    }
    if (e.key === 'Tab' && !tabMovesFocus && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      insert(INDENT);
    } else if (e.key === 'Enter' && !e.isComposing) {
      // Keep the current line's indentation.
      const before = input.value.slice(0, input.selectionStart);
      const indent = /[^\n]*$/.exec(before)![0].match(/^[ \t]*/)![0];
      e.preventDefault();
      insert('\n' + indent);
    }
  });

  /** A tab for a file read from disk; the editor shows once there is one. */
  const attach = (file: { path: string; text: string }): Buffer => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.role = 'tab';
    tab.className = 'file-tab';
    tab.textContent = file.path;
    const buf: Buffer = { ...file, pending: false, tab };
    tab.addEventListener('click', () => show(buf));
    buf.watch = fs!.watch(full(file.path), () => void reload(buf));
    tabs.append(tab);
    buffers.push(buf);
    code.hidden = false;
    empty.hidden = true;
    return buf;
  };

  return {
    async open(nextFs, nextDir, files) {
      this.clear();
      const g = gen;
      fs = nextFs;
      dir = nextDir;
      const loaded = await Promise.all(
        files.map(async (path) => {
          try {
            return { path, text: decoder.decode(await nextFs.readFile(full(path))) };
          } catch {
            return undefined;
          }
        }),
      );
      if (g !== gen) return;
      for (const file of loaded) if (file) attach(file);
      if (!buffers[0]) return;
      show(buffers[0]);
      onState('changes save as you type');
    },
    async add(path) {
      const open = buffers.find((b) => b.path === path);
      if (open) return show(open);
      if (!fs) return;
      const g = gen;
      let text: string;
      try {
        text = decoder.decode(await fs.readFile(full(path)));
      } catch (err) {
        onState(`could not open ${path}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (g !== gen) return;
      show(attach({ path, text }));
    },
    forget(path) {
      const buf = buffers.find((b) => b.path === path);
      if (!buf) return;
      clearTimeout(buf.timer);
      buf.watch?.dispose();
      buf.tab.remove();
      buffers = buffers.filter((b) => b !== buf);
      if (active !== buf) return;
      if (buffers[0]) show(buffers[0]);
      else {
        active = undefined;
        code.hidden = true;
        empty.hidden = false;
      }
    },
    renamed(from, to) {
      const buf = buffers.find((b) => b.path === from);
      if (!buf || !fs) return;
      buf.watch?.dispose();
      buf.path = to;
      buf.tab.textContent = to;
      buf.watch = fs.watch(full(to), () => void reload(buf));
      if (buf === active) input.setAttribute('aria-label', `Edit ${to}`);
    },
    get edited() {
      return edited;
    },
    clear() {
      gen++;
      for (const b of buffers) {
        clearTimeout(b.timer);
        b.watch?.dispose();
      }
      buffers = [];
      active = undefined;
      fs = undefined;
      lines = 0;
      edited = false;
      tabs.replaceChildren();
      input.value = '';
      hl.textContent = '';
      gutter.textContent = '';
      code.hidden = true;
      empty.hidden = false;
      onState('');
    },
  };
}
