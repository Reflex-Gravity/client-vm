// SPDX-License-Identifier: Apache-2.0
// The playground (pages/play/index.astro). A template is a demo's project: it
// boots on the shared runner (../demo/run.ts), and the page adds a file tree,
// more terminals, a second preview client and resizable panes. The template is
// picked in a dialog the toolbar opens, so the side panel only ever shows the
// project's files. ClientVM loads only once a template is picked;
// `?template=<slug>` picks one on arrival.
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
  const treeHelp = $('tree-help');
  const rootLabel = $('root');
  const switcher = $<HTMLButtonElement>('switch');
  const currentName = $('current');
  const currentTag = $('current-tag');
  const about = $<HTMLAnchorElement>('about');
  const closePicker = $<HTMLButtonElement>('close');
  const closeName = $('close-name');
  const switchNote = $('switch-note');
  const previewBody = $('preview-body');
  const preview2 = $<HTMLIFrameElement>('preview-2');
  const twin = $<HTMLButtonElement>('twin');
  const twinFrame = $('twin-frame');
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
  let activeFile: string | undefined;
  const editor = createEditor(
    document.querySelector<HTMLElement>('[data-editor]')!,
    (text) => (editorState.textContent = text),
    (path) => {
      activeFile = path;
      markActive();
    },
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
  /** The port the preview shows. */
  let shown: number | undefined;
  /** The index of the terminal tab in front; 0 is the setup's bash. */
  let activeTerm = 0;
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
    shown = p;
    preview.src = url;
    if (twinOn()) preview2.src = url;
    empty.hidden = true;
    port.textContent = `● port ${p}`;
    ports.value = String(p);
    reload.disabled = false;
    twin.disabled = false;
  };
  /** No server is listening: the preview says so instead of showing a dead page. */
  const noServer = (text: string) => {
    shown = undefined;
    preview.removeAttribute('src');
    preview2.removeAttribute('src');
    empty.hidden = false;
    empty.textContent = text;
    port.textContent = '';
    reload.disabled = true;
    twin.disabled = true;
  };
  const twinOn = () => twin.getAttribute('aria-pressed') === 'true';
  const setTwin = (on: boolean) => {
    twin.setAttribute('aria-pressed', String(on));
    twinFrame.hidden = !on;
    previewBody.classList.toggle('twin', on);
    const url = shown === undefined ? undefined : open.get(shown);
    if (on && url) preview2.src = url;
    if (!on) preview2.removeAttribute('src');
  };
  twin.addEventListener('click', () => setTwin(!twinOn()));
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
    if (shown !== undefined) showPort(shown);
  });

  // ---- file tree ----
  /** Folders the visitor folded; kept across redraws, cleared per template. */
  const collapsed = new Set<string>();
  let entriesShown: Entry[] = [];
  const markActive = () => {
    for (const n of tree.querySelectorAll<HTMLElement>('.node[data-path]')) {
      const on = n.dataset['path'] === activeFile;
      n.classList.toggle('active', on);
      if (on) n.setAttribute('aria-current', 'true');
      else n.removeAttribute('aria-current');
    }
  };
  const redraw = () => {
    drawTree(entriesShown, tree);
    markActive();
  };
  const drawTree = (entries: Entry[], into: HTMLElement) => {
    into.replaceChildren(
      ...entries.map((e) => {
        const li = document.createElement('li');
        const row = document.createElement('div');
        row.className = 'row';
        const node = document.createElement('button');
        node.type = 'button';
        node.className = e.dir ? 'node dir' : 'node';
        const folded = e.dir && collapsed.has(e.path);
        const name = e.path.split('/').at(-1)!;
        node.textContent = e.dir ? `${folded ? '▸' : '▾'} ${name}/` : name;
        node.title = e.path;
        if (e.dir) {
          node.setAttribute('aria-expanded', String(!folded));
          node.setAttribute('aria-label', name);
          node.addEventListener('click', () => {
            if (folded) collapsed.delete(e.path);
            else collapsed.add(e.path);
            redraw();
          });
        } else {
          node.dataset['path'] = e.path;
          node.addEventListener('click', () => void editor.add(e.path));
        }
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
        if (e.children.length && !folded) {
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
      entriesShown = entries;
      redraw();
      treeEmpty.hidden = entries.length > 0;
      treeEmpty.textContent = 'No files yet.';
      treeHelp.hidden = false;
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
    activeTerm = index;
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
      const tool = chip.dataset['playTool'];
      const command = chip.dataset['playTry'];
      try {
        if (tool) {
          // The runner writes tool calls and their results to the first terminal.
          showTerm(0);
          const t = JSON.parse(tool) as { name: string; input: Record<string, unknown> };
          await demo.callTool(t.name, t.input);
        } else if (command) {
          // Into the terminal in front, so a server in another one keeps running.
          const extra = activeTerm > 0 ? extras[activeTerm - 1]?.term : undefined;
          showTerm(extra ? activeTerm : 0);
          await (extra ?? demo).type(command);
        }
      } catch {
        // the terminal shows what happened
      }
    });
  }

  // ---- the template picker ----
  const showPicker = () => {
    overlay.hidden = false;
    fail.hidden = true;
    startScreen.hidden = false;
    const name = current ? demoOf(current)?.name : undefined;
    closePicker.hidden = !running || !name;
    closeName.textContent = name ?? '';
    switchNote.hidden = !running;
    (startScreen.querySelector<HTMLButtonElement>('.card-btn[aria-current="true"]') ??
      startScreen.querySelector<HTMLButtonElement>('.card-btn'))!.focus();
  };
  const hidePicker = () => {
    if (!running) return;
    overlay.hidden = true;
    switcher.focus();
  };
  switcher.addEventListener('click', showPicker);
  closePicker.addEventListener('click', hidePicker);
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !startScreen.hidden) hidePicker();
  });
  const showCurrent = (slug: string | undefined) => {
    const meta = slug ? demoOf(slug) : undefined;
    currentName.textContent = meta?.name ?? 'none yet';
    currentTag.textContent = meta?.tag ?? '';
    about.hidden = !meta;
    if (meta) about.href = `/demos/${meta.slug}/`;
    for (const t of templates)
      t.setAttribute('aria-current', String(t.dataset['playTemplate'] === slug));
  };

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
    activeTerm = 0;
    termTabs.replaceChildren();
    terms.replaceChildren();
    tree.replaceChildren();
    entriesShown = [];
    collapsed.clear();
    treeEmpty.hidden = false;
    treeEmpty.textContent = "The project's files show here once you pick a template.";
    treeHelp.hidden = true;
    rootLabel.textContent = '';
    newFile.disabled = true;
    newTerm.disabled = true;
    editor.clear();
    open.clear();
    drawPorts();
    noServer(
      'The page the project serves shows here. Start a server in any terminal and it opens on its own.',
    );
    setTwin(false);
    agentPreview.replaceChildren();
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
    showCurrent(slug);
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
      rootLabel.textContent = APP.replace(/^\/home\/user/, '~');
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
            if (shown !== p) return;
            const next = [...open.keys()].at(-1);
            if (next !== undefined) showPort(next);
            else
              noServer(
                `The server on port ${p} stopped. Start it again in a terminal and it shows here.`,
              );
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
    switcher.disabled = true;
    status('unsupported browser');
  } else {
    const wanted = new URLSearchParams(location.search).get('template');
    if (wanted && demoOf(wanted)) void start(wanted);
  }
}
