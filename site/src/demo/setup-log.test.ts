// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { SetupLog } from './setup-log.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const texts = (log: SetupLog) => log.getLines().map((l) => `${l.kind}:${l.text}`);

describe('SetupLog', () => {
  it('shows exec commands without the sh -c wrapper', () => {
    const log = new SetupLog(0);
    log.spawn(['sh', '-c', 'npm install --no-audit']);
    log.spawn(['npm', 'run', 'dev']);
    expect(texts(log)).toEqual(['cmd:npm install --no-audit', 'cmd:npm run dev']);
  });

  it('splits output into lines across chunks and flushes the rest on exit', () => {
    const log = new SetupLog(0);
    log.output(1, 1, enc('added 12 pack'));
    expect(texts(log)).toEqual([]);
    log.output(1, 1, enc('ages\nVITE ready'));
    expect(texts(log)).toEqual(['out:added 12 packages']);
    log.exit(1, 0);
    expect(texts(log)).toEqual(['out:added 12 packages', 'out:VITE ready']);
  });

  it('keeps partial lines per process and stream', () => {
    const log = new SetupLog(0);
    log.output(1, 1, enc('a'));
    log.output(2, 1, enc('b'));
    log.output(1, 2, enc('warn\n'));
    log.output(1, 1, enc('1\n'));
    log.output(2, 1, enc('2\n'));
    expect(texts(log)).toEqual(['err:warn', 'out:a1', 'out:b2']);
  });

  it('decodes UTF-8 split across chunks', () => {
    const log = new SetupLog(0);
    const bytes = enc('✓ done\n');
    log.output(1, 1, bytes.slice(0, 1));
    log.output(1, 1, bytes.slice(1));
    expect(texts(log)).toEqual(['out:✓ done']);
  });

  it('strips colours and keeps only the last redraw of a line', () => {
    const log = new SetupLog(0);
    log.output(1, 1, enc('\x1b[2K\x1b[32m10%\x1b[39m\r50%\r'));
    log.output(1, 1, enc('100%\r\n'));
    expect(texts(log)).toEqual(['out:100%']);
  });

  it('drops blank lines and reports failed exits', () => {
    const log = new SetupLog(0);
    log.output(3, 2, enc('\n\nnpm error 404\n'));
    log.exit(3, 1);
    expect(texts(log)).toEqual(['err:npm error 404', 'err:exited with code 1']);
  });

  it('keeps only the most recent lines', () => {
    const log = new SetupLog(0);
    log.output(1, 1, enc(Array.from({ length: 450 }, (_, i) => `line ${i}`).join('\n') + '\n'));
    const lines = log.getLines();
    expect(lines).toHaveLength(400);
    expect(lines[0]!.text).toBe('line 50');
    expect(lines.at(-1)!.text).toBe('line 449');
  });

  it('batches notifications', () => {
    vi.useFakeTimers();
    try {
      const log = new SetupLog(50);
      const cb = vi.fn();
      log.subscribe(cb);
      log.info('a');
      log.info('b');
      expect(cb).not.toHaveBeenCalled();
      vi.advanceTimersByTime(50);
      expect(cb).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
