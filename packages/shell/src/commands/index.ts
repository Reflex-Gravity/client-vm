// SPDX-License-Identifier: Apache-2.0
// The command table: every command here runs in-process when the shell
// resolves it, and is also a standalone runtime (`child_process.spawn('ls')`).

import type { CommandFn } from '../types.ts';
import { gunzip, gzip, tar, zcat } from './archive.ts';
import { curl } from './curl.ts';
import { diff } from './diff.ts';
import { echo, printf } from './echo-printf.ts';
import {
  basenameCmd,
  cat,
  chmod,
  cp,
  dirnameCmd,
  ln,
  ls,
  mkdir,
  mktemp,
  mv,
  readlink,
  realpath,
  rm,
  rmdir,
  stat,
  touch,
} from './files.ts';
import { find, xargs } from './find.ts';
import { git } from './git.ts';
import { grep } from './grep.ts';
import {
  clear,
  date,
  env,
  falseCmd,
  hostname,
  id,
  nproc,
  printenv,
  pwd,
  sleep,
  trueCmd,
  uname,
  which,
  whoami,
} from './misc.ts';
import { sed } from './sed.ts';
import { test } from './test.ts';
import { cut, head, rev, seq, sort, tail, tee, tr, uniq, wc, yes } from './text.ts';

export const COMMANDS: Readonly<Record<string, CommandFn>> = {
  '[': test,
  basename: basenameCmd,
  cat,
  chmod,
  clear,
  cp,
  curl,
  cut,
  date,
  diff,
  dirname: dirnameCmd,
  echo,
  egrep: grep,
  env,
  false: falseCmd,
  fgrep: grep,
  find,
  git,
  grep,
  gunzip,
  gzip,
  head,
  hostname,
  id,
  ln,
  ls,
  mkdir,
  mktemp,
  mv,
  nproc,
  printenv,
  printf,
  pwd,
  readlink,
  realpath,
  rev,
  rm,
  rmdir,
  sed,
  seq,
  sleep,
  sort,
  stat,
  tail,
  tar,
  tee,
  test,
  touch,
  tr,
  true: trueCmd,
  uname,
  uniq,
  wc,
  which,
  whoami,
  xargs,
  yes,
  zcat,
};
