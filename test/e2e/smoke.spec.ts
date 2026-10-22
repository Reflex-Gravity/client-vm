// SPDX-License-Identifier: Apache-2.0
// The npm smoke test (CLAUDE.md §9), curated: 50 popular pure-JavaScript
// packages are installed with real npm in one instance, then each is loaded
// the way its users load it (require or import) and touched once. The full
// top-1,000 run is an opt-in job (docs/open-questions.md).
import { expect, test } from '@playwright/test';
import { host, openHost } from './sandbox.ts';

/** [spec, how to load, a check expression on the loaded module `m`]. */
const PACKAGES: [string, 'require' | 'import', string][] = [
  ['lodash@4', 'require', 'm.chunk([1, 2, 3], 2).length === 2'],
  ['react@18', 'require', "typeof m.createElement === 'function'"],
  ['react-dom@18', 'require', "typeof m.createPortal === 'function'"],
  ['express@4', 'require', "typeof m.Router === 'function'"],
  ['axios@1', 'require', "typeof m.get === 'function'"],
  ['chalk@5', 'import', "m.default.red('x').includes('x')"],
  ['commander@12', 'require', "typeof m.Command === 'function'"],
  ['debug@4', 'require', "typeof m('x') === 'function'"],
  ['uuid@10', 'require', 'm.validate(m.v4())'],
  ['dayjs@1', 'require', "m('2024-01-01').year() === 2024"],
  ['date-fns@3', 'require', "m.format(new Date(2024, 0, 1), 'yyyy') === '2024'"],
  ['moment@2', 'require', "m('2024-01-01').year() === 2024"],
  ['zod@3', 'require', "m.z.string().parse('a') === 'a'"],
  ['yargs@17', 'require', "typeof m === 'function'"],
  ['minimist@1', 'require', "m(['--a', 'b']).a === 'b'"],
  ['semver@7', 'require', "m.gt('1.2.3', '1.2.0')"],
  ['glob@10', 'require', "typeof m.globSync === 'function'"],
  ['fs-extra@11', 'require', "m.pathExistsSync('/')"],
  ['ws@8', 'require', "typeof m.WebSocketServer === 'function'"],
  ['cors@2', 'require', "typeof m() === 'function'"],
  ['dotenv@16', 'require', "typeof m.config === 'function'"],
  ['bcryptjs@2', 'require', "m.compareSync('a', m.hashSync('a', 4))"],
  ['clsx@2', 'require', "m('a', { b: true }) === 'a b'"],
  ['classnames@2', 'require', "m('a', { b: true }) === 'a b'"],
  ['prop-types@15', 'require', "typeof m.string === 'function'"],
  ['redux@5', 'require', "typeof m.legacy_createStore === 'function'"],
  ['@reduxjs/toolkit@2', 'require', "typeof m.configureStore === 'function'"],
  ['immer@10', 'require', 'm.produce({ a: 1 }, (d) => { d.a = 2; }).a === 2'],
  ['rxjs@7', 'require', "typeof m.of === 'function'"],
  ['marked@12', 'require', "m.marked.parse('# a').includes('<h1')"],
  ['cheerio@1.0.0', 'require', "m.load('<p>a</p>')('p').text() === 'a'"],
  ['qs@6', 'require', "m.parse('a=1').a === '1'"],
  ['nanoid@5', 'import', 'm.nanoid().length === 21'],
  ['ajv@8', 'require', "new m.default().validate({ type: 'string' }, 'a')"],
  ['yaml@2', 'require', "m.parse('a: 1').a === 1"],
  ['js-yaml@4', 'require', "m.load('a: 1').a === 1"],
  ['handlebars@4', 'require', "m.compile('{{a}}')({ a: 'x' }) === 'x'"],
  ['ejs@3', 'require', "m.render('<%= a %>', { a: 'x' }) === 'x'"],
  ['koa@2', 'require', "typeof m === 'function'"],
  ['fastify@4', 'require', "typeof m === 'function'"],
  ['socket.io@4', 'require', "typeof m.Server === 'function'"],
  ['postcss@8', 'require', "m.parse('a{b:c}').nodes.length === 1"],
  ['sass@1', 'require', "m.compileString('a{b:c}').css.includes('b: c')"],
  ['vue@3', 'require', "typeof m.createApp === 'function'"],
  ['svelte@4', 'import', "typeof m.onMount === 'function'"],
  ['three@0.169', 'require', 'new m.Vector3(1, 2, 3).length() > 3'],
  ['graphql@16', 'require', "m.parse('{ a }').kind === 'Document'"],
  ['zustand@4', 'require', "typeof m.create === 'function'"],
  ['luxon@3', 'require', "m.DateTime.fromISO('2024-01-01').year === 2024"],
  ['typescript@5', 'require', "m.transpile('let a: number = 1').includes('var a = 1')"],
];

test('npm smoke: 50 popular packages install and load', async ({ page }) => {
  test.setTimeout(600_000);
  await openHost(page);
  const id = await host(page, 'createInstance');
  await host(page, 'exec', id, 'mkdir -p /home/user/app && cd /home/user/app && npm init -y');
  const install = await host(
    page,
    'exec',
    id,
    `npm install --no-fund --no-audit ${PACKAGES.map(([spec]) => spec).join(' ')}`,
    { cwd: '/home/user/app', timeoutMs: 480_000 },
  );
  expect(install.code, install.stderr).toBe(0);

  const name = (spec: string) => spec.slice(0, spec.lastIndexOf('@'));
  const script = `
const checks = ${JSON.stringify(PACKAGES.map(([spec, how, check]) => [name(spec), how, check]))};
(async () => {
  const failures = [];
  for (const [name, how, check] of checks) {
    try {
      const m = how === 'require' ? require(name) : await import(name);
      if (!new Function('m', 'return (' + check + ')')(m)) failures.push(name + ': check failed');
    } catch (e) {
      failures.push(name + ': ' + String(e && e.message).split('\\n')[0]);
    }
  }
  console.log(JSON.stringify(failures));
})();
`;
  await host(page, 'exec', id, `cat > smoke.cjs <<'EOF'\n${script}\nEOF`, {
    cwd: '/home/user/app',
  });
  const r = await host(page, 'exec', id, 'node smoke.cjs', {
    cwd: '/home/user/app',
    timeoutMs: 120_000,
  });
  expect(r.code, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout) as string[]).toEqual([]);
});
