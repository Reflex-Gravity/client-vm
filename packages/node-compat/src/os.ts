// SPDX-License-Identifier: Apache-2.0
import { NODE_VERSION } from './constants.ts';

/**
 * `os`: a believable Linux machine. Values that depend on the real device
 * come from the browser where it exposes them (CPU count); the rest are
 * fixed so builds are deterministic.
 */
export function createOs(env: () => Record<string, string>) {
  const cpus = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 64));
  const started = Date.now();
  return {
    EOL: '\n',
    devNull: '/dev/null',
    arch: () => 'x64',
    platform: () => 'linux',
    type: () => 'Linux',
    release: () => '6.1.0-clientvm',
    version: () => '#1 SMP ClientVM',
    machine: () => 'x86_64',
    hostname: () => 'clientvm',
    homedir: () => env()['HOME'] ?? '/home/user',
    tmpdir: () => {
      const dir = env()['TMPDIR'] ?? env()['TMP'] ?? env()['TEMP'] ?? '/tmp';
      return dir.length > 1 && dir.endsWith('/') ? dir.slice(0, -1) : dir;
    },
    endianness: () => 'LE',
    uptime: () => Math.floor((Date.now() - started) / 1000),
    loadavg: () => [0, 0, 0],
    totalmem: () => 4 * 1024 ** 3,
    freemem: () => 2 * 1024 ** 3,
    availableParallelism: () => cpus,
    cpus: () =>
      Array.from({ length: cpus }, () => ({
        model: 'ClientVM Virtual CPU',
        speed: 2400,
        times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
      })),
    networkInterfaces: () => ({
      lo: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8',
        },
      ],
    }),
    userInfo: () => ({
      uid: 1000,
      gid: 1000,
      username: 'user',
      homedir: env()['HOME'] ?? '/home/user',
      shell: '/bin/sh',
    }),
    getPriority: () => 0,
    setPriority: () => {},
    constants: {
      signals: {
        SIGHUP: 1,
        SIGINT: 2,
        SIGQUIT: 3,
        SIGKILL: 9,
        SIGTERM: 15,
        SIGUSR1: 10,
        SIGUSR2: 12,
      },
      errno: { ENOENT: 2, EACCES: 13, EEXIST: 17, ENOTDIR: 20, EISDIR: 21, EINVAL: 22 },
      priority: { PRIORITY_LOW: 19, PRIORITY_NORMAL: 0, PRIORITY_HIGH: -14 },
    },
    _version: NODE_VERSION,
  };
}
