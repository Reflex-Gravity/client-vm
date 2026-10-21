// SPDX-License-Identifier: Apache-2.0
// readTar/writeTar against GNU tar: archives GNU writes (ustar, pax and gnu
// formats, long names, symlinks) parse correctly, and ours extract with GNU tar.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkIntegrity, readTar, writeTar } from '@clientvm/node-compat';
import { describe, expect, it } from 'vitest';

const LONG = `${'d'.repeat(60)}/${'e'.repeat(70)}/file-${'f'.repeat(40)}.txt`;

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cvm-tar-'));
  mkdirSync(join(dir, 'src', LONG.slice(0, LONG.lastIndexOf('/'))), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.txt'), 'hello\n');
  writeFileSync(
    join(dir, 'src', 'bin.dat'),
    new Uint8Array(1500).map((_, i) => i % 256),
  );
  writeFileSync(join(dir, 'src', LONG), 'deep\n');
  symlinkSync('a.txt', join(dir, 'src', 'link'));
  return dir;
}

describe('readTar parses GNU tar output', () => {
  for (const format of ['gnu', 'pax', 'ustar']) {
    it(format, () => {
      const dir = fixture();
      const args = ['-cf', '-', `--format=${format}`, '-C', dir, 'src'];
      let bytes: Buffer;
      try {
        bytes = execFileSync('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        // ustar cannot store the long path; GNU tar refuses it.
        expect(format).toBe('ustar');
        return;
      }
      const entries = [...readTar(new Uint8Array(bytes))];
      const byPath = new Map(entries.map((e) => [e.path, e]));
      expect(new TextDecoder().decode(byPath.get('src/a.txt')!.data)).toBe('hello\n');
      expect(byPath.get('src/bin.dat')!.data).toEqual(
        new Uint8Array(readFileSync(join(dir, 'src', 'bin.dat'))),
      );
      expect(new TextDecoder().decode(byPath.get(`src/${LONG}`)!.data)).toBe('deep\n');
      expect(byPath.get('src/link')).toMatchObject({ type: 'symlink', linkname: 'a.txt' });
      expect(byPath.get('src/')!.type).toBe('dir');
    });
  }
});

describe('writeTar output extracts with GNU tar', () => {
  it('files, dirs, symlinks, long names, modes', () => {
    const enc = new TextEncoder();
    const bytes = writeTar([
      {
        path: 'p/',
        type: 'dir',
        mode: 0o755,
        mtime: 1700000000,
        linkname: '',
        data: new Uint8Array(),
      },
      {
        path: 'p/x.sh',
        type: 'file',
        mode: 0o755,
        mtime: 1700000000,
        linkname: '',
        data: enc.encode('#!/bin/sh\n'),
      },
      {
        path: `p/${LONG}`,
        type: 'file',
        mode: 0o644,
        mtime: 1700000000,
        linkname: '',
        data: enc.encode('long\n'),
      },
      {
        path: 'p/l',
        type: 'symlink',
        mode: 0o777,
        mtime: 1700000000,
        linkname: 'x.sh',
        data: new Uint8Array(),
      },
    ]);
    const out = mkdtempSync(join(tmpdir(), 'cvm-untar-'));
    writeFileSync(join(out, 'a.tar'), bytes);
    execFileSync('tar', ['-xf', 'a.tar'], { cwd: out });
    expect(readFileSync(join(out, 'p', 'x.sh'), 'utf8')).toBe('#!/bin/sh\n');
    expect(readFileSync(join(out, 'p', LONG), 'utf8')).toBe('long\n');
    expect(readlinkSync(join(out, 'p', 'l'))).toBe('x.sh');
    const listing = execFileSync('tar', ['-tvf', 'a.tar'], { cwd: out, encoding: 'utf8' });
    expect(listing).toMatch(/^-rwxr-xr-x .* p\/x\.sh$/m);
    // And back through our reader.
    expect([...readTar(bytes)].map((e) => e.path)).toEqual(['p/', 'p/x.sh', `p/${LONG}`, 'p/l']);
  });

  it('rejects corrupt archives', () => {
    const bytes = writeTar([
      { path: 'a', type: 'file', mode: 0o644, mtime: 0, linkname: '', data: new Uint8Array(3) },
    ]);
    bytes[10] = 0x41;
    expect(() => [...readTar(bytes)]).toThrow(/checksum/);
    expect(() => [...readTar(new TextEncoder().encode('junk\n'))]).toThrow(/truncated/);
  });
});

describe('checkIntegrity (SRI)', () => {
  it('accepts matching sha512/sha1 and rejects others', async () => {
    const { createHash } = await import('node:crypto');
    const data = new TextEncoder().encode('package bytes');
    const sri = (algo: string) => `${algo}-${createHash(algo).update(data).digest('base64')}`;
    expect(checkIntegrity(data, sri('sha512'))).toBe(true);
    expect(checkIntegrity(data, sri('sha1'))).toBe(true);
    expect(checkIntegrity(data, `sha256-abc ${sri('sha512')}`)).toBe(true);
    expect(checkIntegrity(data, sri('sha256'))).toBe(false);
    expect(checkIntegrity(new TextEncoder().encode('tampered'), sri('sha512'))).toBe(false);
  });
});
