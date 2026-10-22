// SPDX-License-Identifier: Apache-2.0
// Installs one package version from the npm registry into a directory:
// download, verify the published integrity (SRI), gunzip, untar, then rename
// into place so a half-written copy is never used. Used for npm itself
// (ADR 0012) and for WebAssembly stand-ins of native packages (ADR 0013).
// The sync variant uses synchronous XHR, which dedicated workers allow; it
// serves `require()`, which cannot wait for a promise.

import { createFs } from './fs.ts';
import { digestFor } from './hashes.ts';
import { readTar } from './tar.ts';
import { createZlib } from './zlib.ts';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

type Fs = ReturnType<typeof createFs>;

export interface PackageSource {
  /** Tarball URL. */
  tarball: string;
  /** Subresource integrity, e.g. `sha512-...` (sha512 or sha1). */
  integrity: string;
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** Checks `bytes` against an SRI string (any listed sha512/sha1 hash may match). */
export function checkIntegrity(bytes: Uint8Array, integrity: string): boolean {
  for (const entry of integrity.trim().split(/\s+/)) {
    const dash = entry.indexOf('-');
    const algo = entry.slice(0, dash);
    if (algo !== 'sha512' && algo !== 'sha1') continue;
    const digest = digestFor(algo)!;
    digest.update(bytes);
    if (base64(digest.digest()) === entry.slice(dash + 1).replace(/\?.*$/, '')) return true;
  }
  return false;
}

/** The registry document URL for one version (`/@scope%2fname/1.2.3`). */
function versionUrl(registry: string, name: string, version: string): string {
  return `${registry.replace(/\/$/, '')}/${name.replace('/', '%2f')}/${encodeURIComponent(version)}`;
}

let zlib: Record<string, unknown> | undefined;
const gunzip = (b: Uint8Array) =>
  (
    (zlib ??= createZlib(() => {
      throw new Error('zlib streams are not needed here');
    }))['gunzipSync'] as (x: Uint8Array) => Uint8Array
  )(b);

/** Unpacks a verified npm tarball (`package/` prefix stripped) at `dest`. */
export function unpackPackage(fs: Fs, tgz: Uint8Array, dest: string, pid: number): void {
  const tar = gunzip(tgz);
  const staging = `${dest}.staging-${pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const entry of readTar(tar)) {
    // npm tarballs put everything under one top-level directory (usually `package/`).
    const rel = entry.path.replace(/^[^/]+\//, '').replace(/\/$/, '');
    if (!rel || rel.split('/').some((part) => part === '..')) continue;
    const target = `${staging}/${rel}`;
    if (entry.type === 'dir') {
      fs.mkdirSync(target, { recursive: true });
    } else if (entry.type === 'file') {
      fs.mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true });
      fs.writeFileSync(target, entry.data);
      // Packed modes are often 0644 even for bins; keep any exec bit as 0755.
      fs.chmodSync(target, entry.mode & 0o111 ? 0o755 : 0o644);
    }
  }
  fs.mkdirSync(dest.slice(0, dest.lastIndexOf('/')) || '/', { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(staging, dest);
}

function verify(bytes: Uint8Array, source: PackageSource): void {
  if (!checkIntegrity(bytes, source.integrity)) {
    throw new Error(`integrity check failed for ${source.tarball}`);
  }
}

/** Downloads, verifies and unpacks `source` at `dest`. */
export async function installTarball(
  fs: Fs,
  source: PackageSource,
  dest: string,
  pid: number,
): Promise<void> {
  const res = await fetch(source.tarball);
  if (!res.ok) throw new Error(`fetching ${source.tarball}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  verify(bytes, source);
  unpackPackage(fs, bytes, dest, pid);
}

/** Looks up `name@version` in the registry and installs it at `dest`. */
export async function installFromRegistry(
  fs: Fs,
  name: string,
  version: string,
  dest: string,
  pid: number,
  registry = DEFAULT_REGISTRY,
): Promise<void> {
  const url = versionUrl(registry, name, version);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetching ${url}: HTTP ${res.status}`);
  const doc = (await res.json()) as { dist?: PackageSource };
  if (!doc.dist?.tarball || !doc.dist.integrity) throw new Error(`no dist for ${name}@${version}`);
  await installTarball(fs, doc.dist, dest, pid);
}

function getSync(url: string, binary: boolean): Uint8Array | string {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, false);
  if (binary) xhr.responseType = 'arraybuffer';
  xhr.send();
  if (xhr.status < 200 || xhr.status >= 300) throw new Error(`fetching ${url}: HTTP ${xhr.status}`);
  return binary ? new Uint8Array(xhr.response as ArrayBuffer) : xhr.responseText;
}

/** `installFromRegistry` for synchronous callers (blocks the process's worker). */
export function installFromRegistrySync(
  fs: Fs,
  name: string,
  version: string,
  dest: string,
  pid: number,
  registry = DEFAULT_REGISTRY,
): void {
  if (typeof XMLHttpRequest === 'undefined') {
    throw new Error(`cannot download ${name}@${version} synchronously here`);
  }
  const doc = JSON.parse(getSync(versionUrl(registry, name, version), false) as string) as {
    dist?: PackageSource;
  };
  if (!doc.dist?.tarball || !doc.dist.integrity) throw new Error(`no dist for ${name}@${version}`);
  const bytes = getSync(doc.dist.tarball, true) as Uint8Array;
  verify(bytes, doc.dist);
  unpackPackage(fs, bytes, dest, pid);
}
