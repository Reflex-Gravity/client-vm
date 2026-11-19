// SPDX-License-Identifier: Apache-2.0
// The playground (pages/play/index.astro). A template is a demo's project: it
// boots on the shared runner (../demo/run.ts), and the page adds a file tree,
// more terminals and resizable panes. ClientVM loads only once a template is
// picked; `?template=<slug>` picks one on arrival.
import { checkSupport } from '../demo/support.ts';
import { createEditor } from '../demo/editor.ts';
import { demoOf, loadDefinition, type SetupStep } from '../demos/catalog.ts';
import type { ExtraTerminal, RunningDemo } from '../demo/run.ts';
import { makeSplit } from './split.ts';
import type { FileSystem } from '@clientvm/clientvm';

/** Not listed in the tree: installed packages, git's store, build output. */
const HIDDEN = new Set(['node_modules', '.git', 'dist', '.npm', '.cache']);
/** The tree stops here, so a huge project cannot stall the page. */
const MAX_ENTRIES = 400;
const TREE_REFRESH_MS = 250;
const LIKELY_CAUSE =
  'A dropped connection while npm or the WebAssembly build tools download is the usual cause. ' +
  'Retrying is usually worth it; the browser console has the details.';

const root = document.querySelector<HTMLElement>('[data-play]');
const $ = <T extends HTMLElement>(name: string) =>
  document.querySelector<T>(`[data-play-${name}]`)!;
const all = <T extends HTMLElement>(selector: string) => [
  ...document.querySelectorAll<T>(selector),
];

interface Entry {
  path: string;
  dir: boolean;
  children: Entry[];
}

/** The project's files under `dir`, directories first, without the HIDDEN ones. */
async function listTree(fs: FileSystem, dir: string, prefix = '', budget = { n: 0 }) {
  const out: Entry[] = [];
  let entries;
  try {
    entries = await fs.readdir(prefix ? `${dir}/${prefix}` : dir);
  } catch {
    return out;
  }
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
  );
  for (const e of entries) {
    if (HIDDEN.has(e.name) || budget.n++ > MAX_ENTRIES) continue;
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    const isDir = e.type === 'dir';
    out.push({
      path,
      dir: isDir,
      children: isDir ? await listTree(fs, dir, path, budget) : [],
    });
  }
  return out;
}

if (root) {
  const overlay = $('overlay');
  const startScreen = $('start');
  const fail = $('fail');
  const failTitle = $('fail-title');
  const failNote = $('fail-note');
  const retry = $<HTMLButtonElement>('retry');
  const tree = $('tree');
  const treeEmpty = $('tree-empty');
  const newFile = $<HTMLButtonElement>('new-file');
  const termTabs = $('term-tabs');
  const terms = $('terms');
  const newTerm = $<HTMLButtonElement>('new-term');
  const preview = $<HTMLIFrameElement>('preview');
  const agentPreview = $('agent-preview');
  const empty = $('empty');
  const port = $('port');
  const ports = $<HTMLSelectElement>('ports');
  const reload = $<HTMLButtonElement>('reload');
  const stepItems = all<HTMLLIElement>('[data-play-steps] li');
  const status = (text: string) => ($('status').textContent = text);
  const editorState = document.querySelector<HTMLElement>('[data-editor-state]')!;
  const editor = createEditor(
    document.querySelector<HTMLElement>('[data-editor]')!,
    (text) => (editorState.textContent = text),
  );
  const templates = all<HTMLButtonElement>('[data-play-template]');
  const chipGroups = all<HTMLElement>('[data-play-chips]');
  const chips = all<HTMLButtonElement>('[data-play-chips] .chip');

  let running: RunningDemo | undefined;
  let current: string | undefined;
  let app = '';
  /** Bumped on every start and stop, so a stale boot cannot touch the page. */
  let run = 0;
  const open = new Map<number, string>();
  const extras: { tab: HTMLButtonElement; box: HTMLElement; term?: ExtraTerminal }[] = [];
  let unwatch: (() => void) | undefined;

  // ---- panes ----
  const workEl = document.querySelector<HTMLElement>('[data-work]')!;
  const left = workEl.querySelector<HTMLElement>('.left')!;
  for (const handle of all<HTMLElement>('[data-split]')) {
    const which = handle.dataset['split'];
    if (which === 'side')
      makeSplit(root, handle, {
        prop: '--side',
        unit: 'px',
        axis: 'x',
        min: 160,
        max: 420,
        area: () => root,
      });
    if (which === 'left')
      makeSplit(root, handle, {
        prop: '--left',
        unit: '%',
        axis: 'x',
        min: 25,
        max: 75,
        area: () => workEl,
      });
    if (which === 'term')
      makeSplit(root, handle, {
        prop: '--term',
        unit: '%',
        axis: 'y',
        min: 15,
        max: 80,
        area: () => left,
      });
  }

  // ---- setup strip ----
  const showStep = (slug: string | undefined, step: SetupStep | undefined) => {
    const steps = slug ? (demoOf(slug)?.steps ?? []) : [];
    const at = step ? steps.indexOf(step) : -1;
    for (const li of stepItems) {
      const i = steps.indexOf(li.dataset['step'] as SetupStep);
      li.classList.toggle('skip', i < 0);
      li.classList.toggle('done', i >= 0 && (i < at || (step === 'ready' && i === at)));
      li.classList.toggle('now', i >= 0 && i === at && step !== 'ready');
    }
  };

  // ---- preview ----
  const showPort = (p: number) => {
    const url = open.get(p);
    if (url === undefined) return;
    preview.src = url;
    empty.hidden = true;
    port.textContent = `● port ${p}`;
    ports.value = String(p);
    reload.disabled = false;
  };
  const drawPorts = () => {
    const list = [...open.keys()].sort((a, b) => a - b);
    ports.replaceChildren(
      ...list.map((p) => {
        const option = document.createElement('option');
        option.value = String(p);
        option.textContent = `port ${p}`;
        return option;
      }),
    );
    ports.hidden = list.length < 2;
    port.hidden = list.length >= 2;
  };
  ports.addEventListener('change', () => showPort(Number(ports.value)));
  reload.addEventListener('click', () => {
    const p = Number(ports.hidden ? [...open.keys()].at(-1) : ports.value);
    if (open.has(p)) showPort(p);
  });

  // ---- file tree ----
  const drawTree = (entries: Entry[], into: HTMLElement) => {
    into.replaceChildren(
      ...entries.map((e) => {
        const li = document.createElement('li');
        const row = document.createElement('div');
        row.className = 'row';
        const node = document.createElement('button');
        node.type = 'button';
        node.className = e.dir ? 'node dir' : 'node';
        node.textContent = (e.dir ? '▾ ' : '') + e.path.split('/').at(-1);
        node.title = e.path;
        if (!e.dir) node.addEventListener('click', () => void editor.add(e.path));
        row.append(node);
        if (!e.dir) {
          for (const [label, act] of [
            ['rename', () => void renameFile(e.path)],
            ['delete', () => void deleteFile(e.path)],
          ] as const) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'act';
            b.textContent = label === 'rename' ? '✎' : '×';
            b.title = `${label} ${e.path}`;
            b.setAttribute('aria-label', `${label} ${e.path}`);
            b.addEventListener('click', act);
            row.append(b);
          }
        }
        li.append(row);
        if (e.children.length) {
          const ul = document.createElement('ul');
          drawTree(e.children, ul);
          li.append(ul);
        }
        return li;
      }),
    );
  };
  let treeTimer: ReturnType<typeof setTimeout> | undefined;
  const refreshTree = () => {
    clearTimeout(treeTimer);
    treeTimer = setTimeout(async () => {
      const demo = running;
      if (!demo) return;
      const entries = await listTree(demo.instance.fs, app);
      if (demo !== running) return;
      drawTree(entries, tree);
      treeEmpty.hidden = entries.length > 0;
      treeEmpty.textContent = 'No files yet.';
    }, TREE_REFRESH_MS);
  };

  /** A path inside the project, or undefined (and a message) if it is not one. */
  const projectPath = (input: string | null): string | undefined => {
    const path = input?.trim().replace(/^\.?\/+/, '');
    if (!path) return undefined;
    if (path.split('/').some((p) => p === '..' || p === '')) {
      status('a file name cannot contain .. or empty parts');
      return undefined;
    }
    return path;
  };
  const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');

  const createFile = async () => {
    const demo = running;
    const path = projectPath(prompt('New file, relative to ~/app:', 'src/new-file.js'));
    if (!demo || !path) return;
    try {
      if (parentOf(path))
        await demo.instance.fs.mkdir(`${app}/${parentOf(path)}`, { recursive: true });
      await demo.instance.fs.writeFile(`${app}/${path}`, '');
      await editor.add(path);
      refreshTree();
    } catch (err) {
      status(`could not create ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const renameFile = async (from: string) => {
    const demo = running;
    const to = projectPath(prompt(`Rename ${from} to:`, from));
    if (!demo || !to || to === from) return;
    try {
      if (parentOf(to)) await demo.instance.fs.mkdir(`${app}/${parentOf(to)}`, { recursive: true });
      await demo.instance.fs.rename(`${app}/${from}`, `${app}/${to}`);
      editor.renamed(from, to);
      refreshTree();
    } catch (err) {
      status(`could not rename ${from}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const deleteFile = async (path: string) => {
    const demo = running;
    if (!demo || !confirm(`Delete ${path}?`)) return;
    try {
      await demo.instance.fs.rm(`${app}/${path}`);
      editor.forget(path);
      refreshTree();
    } catch (err) {
      status(`could not delete ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  newFile.addEventListener('click', () => void createFile());

  // ---- terminals ----
  const showTerm = (index: number) => {
    const tabs = [...termTabs.querySelectorAll<HTMLButtonElement>('.term-tab')];
    const boxes = [...terms.querySelectorAll<HTMLElement>('.term')];
    tabs.forEach((t, i) => t.setAttribute('aria-selected', String(i === index)));
    boxes.forEach((b, i) => (b.hidden = i !== index));
    // A hidden xterm.js has no size; it fits itself once shown (run.ts).
    if (index === 0) running?.focus();
    else extras[index - 1]?.term?.focus();
  };
  const addTab = (label: string): { tab: HTMLButtonElement; box: HTMLElement } => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.role = 'tab';
    tab.className = 'term-tab';
    tab.textContent = label;
    const box = document.createElement('div');
    box.className = 'term';
    termTabs.append(tab);
    terms.append(box);
    const index = termTabs.children.length - 1;
    tab.addEventListener('click', () => showTerm(index));
    return { tab, box };
  };
  newTerm.addEventListener('click', async () => {
    const demo = running;
    if (!demo) return;
    const { tab, box } = addTab(`bash ${termTabs.children.length + 1}`);
    const slot: (typeof extras)[number] = { tab, box };
    extras.push(slot);
    showTerm(termTabs.children.length - 1);
    try {
      slot.term = await demo.newTerminal(box);
      if (demo === running) slot.term.focus();
      else slot.term.dispose();
    } catch (err) {
      status(`could not open a terminal: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ---- chips ----
  const showChips = (slug: string | undefined, enabled: boolean) => {
    for (const g of chipGroups) g.hidden = g.dataset['playChips'] !== slug;
    for (const c of chips) c.disabled = !enabled;
  };
  for (const chip of chips) {
    chip.addEventListener('click', async () => {
      const demo = running;
      if (!demo) return;
      showTerm(0);
      const tool = chip.dataset['playTool'];
      const command = chip.dataset['playTry'];
      try {
        if (tool) {
          const t = JSON.parse(tool) as { name: string; input: Record<string, unknown> };
          await demo.callTool(t.name, t.input);
        } else if (command) await demo.type(command);
      } catch {
        // the terminal shows what happened
      }
    });
  }

  // ---- start and stop ----
  const panel = (title: string, message: string, canRetry: boolean) => {
    overlay.hidden = false;
    startScreen.hidden = true;
    fail.hidden = false;
    failTitle.textContent = title;
    failNote.textContent = message;
    retry.hidden = !canRetry;
  };

  const stop = async () => {
    run++;
    const demo = running;
    running = undefined;
    unwatch?.();
    unwatch = undefined;
    clearTimeout(treeTimer);
    for (const x of extras.splice(0)) x.term?.dispose();
    termTabs.replaceChildren();
    terms.replaceChildren();
    tree.replaceChildren();
    treeEmpty.hidden = false;
    treeEmpty.textContent = 'Pick a template to see its files.';
    newFile.disabled = true;
    newTerm.disabled = true;
    editor.clear();
    open.clear();
    drawPorts();
    preview.removeAttribute('src');
    agentPreview.replaceChildren();
    empty.hidden = false;
    port.textContent = '';
    reload.disabled = true;
    showChips(undefined, false);
    showStep(undefined, undefined);
    if (demo) {
      status('stopping…');
      await demo.destroy();
    }
    status('idle');
  };

  const start = async (slug: string) => {
    const meta = demoOf(slug);
    if (!meta) return;
    if (running && editor.edited && !confirm('Switch templates? Your changes will be lost.')) {
      return;
    }
    await stop();
    const id = ++run;
    current = slug;
    for (const t of templates)
      t.setAttribute('aria-current', String(t.dataset['playTemplate'] === slug));
    history.replaceState(null, '', `?template=${slug}`);
    overlay.hidden = true;
    fail.hidden = true;
    showChips(slug, false);
    showStep(slug, 'boot');
    const { box } = addTab('bash 1');
    showTerm(0);
    try {
      const [{ startDemo, APP }, definition] = await Promise.all([
        import('../demo/run.ts'),
        loadDefinition(slug),
      ]);
      app = APP;
      const demo = await startDemo(
        definition,
        box,
        {
          status: (text) => id === run && status(text),
          step: (step) => id === run && showStep(slug, step),
          firstRun: () => id === run && status('first run in this browser: building it once…'),
          preview: (url, p) => {
            if (id !== run) return;
            open.set(p, url);
            drawPorts();
            showPort(p);
          },
          portClosed: (p) => {
            if (id !== run) return;
            open.delete(p);
            drawPorts();
            const next = [...open.keys()].at(-1);
            if (ports.value === String(p) && next !== undefined) showPort(next);
          },
        },
        definition.agentTools ? { agentPreview } : {},
      );
      if (id !== run) return void demo.destroy();
      running = demo;
      newFile.disabled = false;
      newTerm.disabled = false;
      demo.focus();
      void editor.open(demo.instance.fs, APP, definition.editable);
      const watch = demo.instance.fs.watch(APP, (e) => {
        const path = 'path' in e ? e.path : e.to;
        if (!path.split('/').some((p) => HIDDEN.has(p))) refreshTree();
      });
      unwatch = () => watch.dispose();
      refreshTree();
      demo.setup.then(
        () => id === run && showChips(slug, true),
        () => {
          if (id !== run) return;
          showChips(slug, true);
          status('setup failed: the terminal shows why');
        },
      );
    } catch (err) {
      if (id !== run) return;
      showStep(undefined, undefined);
      status('failed');
      const message = err instanceof Error ? err.message : String(err);
      panel('The sandbox failed to boot', `${message}. ${LIKELY_CAUSE}`, true);
    }
  };

  retry.addEventListener('click', () => current && void start(current));
  for (const t of templates) {
    t.addEventListener('click', () => void start(t.dataset['playTemplate']!));
  }

  window.addEventListener('beforeunload', (e) => {
    if (running && editor.edited) e.preventDefault();
  });

  const support = checkSupport();
  if (!support.ok) {
    panel('Unsupported browser', support.reason, false);
    for (const t of templates) t.disabled = true;
    status('unsupported browser');
  } else {
    const wanted = new URLSearchParams(location.search).get('template');
    if (wanted && demoOf(wanted)) void start(wanted);
  }
}
