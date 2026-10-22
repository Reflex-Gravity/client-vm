// SPDX-License-Identifier: Apache-2.0

const SHELLS = new Set(['sh', 'bash', '/bin/sh', '/bin/bash']);
const PLAIN = /^[\w@%+=:,./-]+$/;

/**
 * How a process's command reads to a person: the command line itself for
 * `sh -c <line>` (what `exec` and the agent tools run), otherwise the argv
 * quoted the way a shell would need it.
 */
export function displayCommand(argv: readonly string[]): string {
  if (argv.length === 3 && SHELLS.has(argv[0]!) && argv[1] === '-c') return argv[2]!;
  return argv.map((a) => (PLAIN.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`)).join(' ');
}

/** Removes ANSI escape sequences, for showing output as plain text. */
export function stripAnsi(text: string): string {
  return text.replace(
    // CSI (ESC [ or C1), string sequences ending in BEL or ST, and two-byte ESC sequences.
    // eslint-disable-next-line no-control-regex
    /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x1b[ -/]*[0-~]/g,
    '',
  );
}
