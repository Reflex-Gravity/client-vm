// SPDX-License-Identifier: Apache-2.0
// Differential tests: each script runs under real bash (GNU coreutils) and
// under ClientVM's shell; stdout, exit status and (by default) stderr must match.

import { describe, expect, it } from 'vitest';
import { runOurs, runReal } from './shell-harness.ts';
import type { FileTree } from './shell-harness.ts';

interface Case {
  script: string;
  files?: FileTree;
  stdin?: string;
  /** Compare stderr too (default true). */
  stderr?: boolean;
}

const TREE: FileTree = {
  'a.txt': 'apple\nbanana\ncherry\n',
  'b.txt': 'one two three\nfour five\n\nsix\n',
  'nums.txt': '10\n2\n33\n4\n2\n',
  'data.csv': 'name,age,city\nalice,30,paris\nbob,25,london\ncarol,35,berlin\n',
  'dir/x.js': 'console.log(1)\n',
  'dir/y.ts': 'export {}\n',
  'dir/sub/z.js': 'z\n',
  '.hidden': 'h\n',
  empty: '',
  'nonl.txt': 'no newline',
  link: { symlink: 'a.txt' },
  'run.sh': { mode: 0o755, content: '#!/bin/sh\necho "args: $#" "$@"\nexit 3\n' },
};

const SHELL_CASES: Record<string, Case> = {
  // words and quoting
  'echo basics': { script: 'echo hello world; echo "a  b"   c; echo \'$HOME\' "x\\$y" a\\ b' },
  'echo flags': { script: 'echo -n hi; echo; echo -e "a\\tb\\nc"; echo -E "a\\tb"; echo -- -n' },
  'ansi-c quoting': { script: "echo $'a\\tb' $'\\x41\\101' $'it\\'s' $'\\cA' $'\\e' | cat -A" },
  'adjacent quoting': { script: 'x=1; echo "a"\'b\'$x"c${x}d"' },
  'empty args': { script: 'set -- "" a ""; echo $#; for x in "$@"; do echo "[$x]"; done' },
  // parameters
  positional: { script: 'set -- a "b c" d; echo $# "$1" "$2"; shift; echo "$@"; echo "$*"' },
  'special params': {
    script:
      'f() { return 7; }; f; echo $?; true; echo $?; echo ${#HOME} >/dev/null; echo $0 | wc -c >/dev/null',
  },
  'default ops': {
    script: 'unset u; e=; echo "${u-d1}" "${u:-d2}" "${e-d3}" "${e:-d4}" "${HOME:+set}" "${u+set}"',
  },
  'assign op': { script: 'unset v; echo "${v:=x}" "$v"; echo "${v:=y}"' },
  'error op': { script: 'unset v; echo "${v:?is unset}"; echo after' },
  length: { script: 'v=hello; echo ${#v}; set -- 1 2 3; echo ${#@} ${#}' },
  trim: { script: 'p=/usr/local/lib/file.tar.gz; echo ${p#*/} ${p##*/} ${p%.*} ${p%%.*}' },
  replace: { script: 'v=aXbXc; echo ${v/X/-} ${v//X/-} ${v/#a/A} ${v/%c/C} ${v//X}' },
  substring: { script: 'v=abcdefg; echo ${v:2} ${v:2:3} ${v: -3} ${v: -3:2} ${v:1:-2}' },
  'case conv': { script: 'v=hello; echo ${v^} ${v^^}; w=WORLD; echo ${w,} ${w,,}' },
  indirect: { script: 'a=b; b=deep; echo ${!a}' },
  nounset: { script: 'set -u; echo ${undefined_var}; echo not reached' },
  // splitting and globbing
  'field splitting': {
    script:
      'v="a  b   c"; for x in $v; do echo "<$x>"; done; IFS=,; w="1,,2,"; for x in $w; do echo "[$x]"; done',
  },
  'ifs whitespace mix': {
    script: 'IFS=" ,"; v=" a , b,,c "; set -- $v; echo $#; printf "<%s>\\n" "$@"',
  },
  glob: { script: 'echo *.txt; echo dir/*; echo nomatch*; echo .h*; echo d?r', files: TREE },
  'glob brackets': { script: 'echo [ab].txt; echo [!a]*.txt; echo [[:alpha:]]*.csv', files: TREE },
  'glob quoted': { script: 'echo "*.txt" \'*\' \\*', files: TREE },
  'glob in var': { script: 'p="*.txt"; echo $p; echo "$p"', files: TREE },
  noglob: { script: 'set -f; echo *.txt', files: TREE },
  'brace expansion': { script: 'echo a{b,c}d {1..5} {05..10..2} {a..e} {z..v..2} x{1,2}{a,b}' },
  'brace non-expansion': { script: 'echo {} {a} a{,}b {1..} "{a,b}" ${HOME+{x,y}}' },
  tilde: { script: 'echo ~ ~/x "~" ~nouser; x=~/a:~/b; echo $x | sed "s|$HOME|H|g"' },
  // command substitution and arithmetic
  'command substitution': {
    script: 'echo "$(echo a; echo b)"; x=`echo hi`; echo $x; echo $(echo "  sp  ")',
  },
  'nested substitution': { script: 'echo $(echo $(echo deep) $(( 1 + $(echo 2) )))' },
  'trailing newlines stripped': { script: 'x=$(printf "a\\n\\n\\n"); echo "[$x]"' },
  arithmetic: {
    script:
      'echo $((1+2*3)) $(( (1+2)*3 )) $((7/2)) $((7%3)) $((-7/2)) $((2**10)) $((1<<4)) $((0x1f)) $((010)) $((2#101))',
  },
  'arith vars': { script: 'i=5; echo $((i+1)) $((i*=2)) $i $((i++)) $i $((++i)) $((i--))' },
  'arith logic': {
    script: 'echo $((1&&0)) $((1||0)) $((!5)) $((3>2?10:20)) $((5&3)) $((5|3)) $((5^3)) $((~0))',
  },
  'arith errors': { script: 'echo $((1/0)); echo after' },
  'arith command': {
    script: '(( 3 > 2 )) && echo yes; (( 0 )) || echo zero; x=3; ((x+=4)); echo $x',
  },
  let: { script: 'let a=5 b=a*2; echo $a $b; let "c = 0"; echo $?' },
  // control flow
  'if elif else': {
    script:
      'for v in 1 2 3; do if [ $v = 1 ]; then echo one; elif [ $v = 2 ]; then echo two; else echo other; fi; done',
  },
  'while until': {
    script:
      'i=0; while [ $i -lt 3 ]; do echo $i; i=$((i+1)); done; until [ $i -eq 0 ]; do i=$((i-1)); done; echo $i',
  },
  'break continue': {
    script:
      'for i in 1 2 3 4 5; do [ $i = 2 ] && continue; [ $i = 4 ] && break; echo $i; done; for a in 1 2; do for b in x y; do [ $b = y ] && continue 2; echo $a$b; done; done',
  },
  'for c-style': { script: 'for ((i=0; i<3; i++)); do echo $i; done' },
  case: {
    script:
      'for w in apple Banana cherry 42 x; do case $w in a*) echo A;; [Bb]*|c*) echo BC;; [0-9]*) echo num;; *) echo other;; esac; done',
  },
  'case fallthrough': {
    script: 'case b in a) echo a;; b) echo b;& c) echo c;;& *) echo star;; esac',
  },
  'and or': {
    script: 'true && echo a || echo b; false && echo c || echo d; false || false || echo e',
  },
  negation: { script: '! false; echo $?; ! true; echo $?' },
  functions: {
    script: 'f() { echo "f:$1:$#"; }; f a b; function g { echo g; return 3; }; g; echo $?',
  },
  'function locals': {
    script: 'x=global; f() { local x=local; echo $x; g; }; g() { echo "g sees $x"; }; f; echo $x',
  },
  recursion: {
    script:
      'fact() { if [ $1 -le 1 ]; then echo 1; else echo $(( $1 * $(fact $(( $1 - 1 ))) )); fi; }; fact 6',
  },
  'subshell isolation': { script: 'x=1; (x=2; cd /; echo $x); echo $x; pwd >/dev/null' },
  group: { script: '{ echo a; echo b; } | wc -l' },
  'exit status of pipeline': {
    script: 'false | true; echo $?; true | false; echo $?; set -o pipefail; false | true; echo $?',
  },
  errexit: { script: 'set -e; echo a; false; echo b' },
  'errexit exempt': {
    script:
      'set -e; if false; then :; fi; false || true; ! true; f() { false; echo inf; }; f && true; echo survived',
  },
  'exit in subshell': { script: '(exit 4); echo $?; x=$(exit 5); echo $?' },
  eval: { script: 'cmd="echo hi; echo there"; eval $cmd; eval "x=5"; echo $x' },
  source: { script: 'echo "y=sourced; return 2" > s.sh; . ./s.sh; echo $? $y' },
  getopts: {
    script:
      'set -- -a -b val -c rest; while getopts "ab:c" o; do echo "$o ${OPTARG-}"; done; shift $((OPTIND-1)); echo "$@"',
  },
  read: { script: 'printf "a b c\\nd e\\n" | { read x y; echo "$x|$y"; read z; echo $z; }' },
  'read loop': {
    script: 'while IFS=, read -r n a c; do echo "$n is $a"; done < data.csv',
    files: TREE,
  },
  'read raw': {
    script:
      'printf "a\\\\tb\\n" | { read -r x; echo "$x"; }; printf "a\\\\tb\\n" | { read x; echo "$x"; }',
  },
  'read eof': { script: 'printf "last" | { read x; echo "$? $x"; }' },
  'here doc': {
    script:
      "x=world; cat <<EOF\nhello $x\n$(echo sub) \\$x\nEOF\ncat <<'Q'\nraw $x\nQ\ncat <<-T\n\tindented\n\tT\necho done",
  },
  'here string': { script: 'cat <<< "hi there"; read a b <<< "1 2"; echo $b' },
  // redirections
  redirects: {
    script:
      'echo a > f; echo b >> f; cat f; cat < f | wc -l; echo err >&2 2>/dev/null; ls nope 2>/dev/null; echo $?',
  },
  'fd dup': { script: '{ echo out; echo err >&2; } 2>&1 | sort; { echo x >&2; } 2>&1 >/dev/null' },
  'redirect both': {
    script: 'ls a.txt nope &> out; cat out; ls nope > o2 2>&1; cat o2',
    files: TREE,
  },
  noclobber: { script: 'set -C; echo a > f; echo b > f; echo $?; echo c >| f; cat f' },
  'redirect errors': { script: 'cat < missing; echo $?; echo x > nodir/f; echo $?' },
  'exec redirect': { script: 'exec > out.txt; echo hidden; exec >&2; cat out.txt', stderr: false },
  // builtins
  printf: {
    script:
      'printf "%s-%d-%5.2f|%-4s|%04d|%x|%o|%c|%%\\n" str 42 3.14159 ab 7 255 8 xyz; printf "%s\\n" a b c; printf "%b\\n" "x\\ty"; printf "%q\\n" "a b"',
  },
  'printf numbers': {
    script:
      'printf "%d %i %u\\n" -5 "\'A" 010; printf "%e %g %G\\n" 12345.678 0.0001 1e20; printf "%10.3s|\\n" abcdef',
  },
  'printf -v': { script: 'printf -v x "%03d" 7; echo $x' },
  test: {
    script:
      '[ -f a.txt ] && echo f; [ -d dir ] && echo d; [ -e nope ] || echo ne; [ -s empty ] || echo empty; [ -L link ] && echo L; [ a = a -a b != c ] && echo and; [ 10 -gt 9 ] && echo gt; test -z "" && echo z; [ ! -x a.txt ] && echo nx; [ -x run.sh ] && echo x',
    files: TREE,
  },
  'test errors': { script: '[ 1 -eq a ]; echo $?; [ a = ]; echo $?' },
  'double bracket': {
    script:
      'x=hello; [[ $x == h* ]] && echo glob; [[ $x =~ ^h(el)lo$ ]] && echo regex; [[ -n $x && $x != world ]] && echo and; [[ a < b ]] && echo lt; [[ ! -e nope ]] && echo none',
  },
  'double bracket quoting': {
    script:
      'x="a b"; [[ $x == "a b" ]] && echo eq; [[ $x == a* ]] && echo g; [[ "$x" == "a*" ]] || echo literal',
  },
  'cd pwd': {
    script:
      'cd dir; pwd | sed "s|.*/||"; cd sub; cd ..; basename "$PWD"; cd -; cd /nonexistent; echo $?',
    files: TREE,
    stderr: false,
  },
  export: {
    script:
      'export A=1; B=2; sh -c \'echo "${A-unset} ${B-unset}"\'; C=3 sh -c \'echo $C\'; echo "${C-gone}"',
  },
  unset: {
    script:
      'x=1; unset x; echo "${x-unset}"; f() { :; }; unset -f f; type f >/dev/null 2>&1 || echo nof',
  },
  readonly: { script: 'readonly r=1; r=2; echo $?; echo $r' },
  'type command': {
    script:
      'type cd echo; f() { :; }; type -t f; command -v cd; command -v nonexist || echo nf; type -t if',
  },
  'command not found': { script: 'nonexistentcmd; echo $?; ./nope; echo $?' },
  'set positional': { script: 'set -- x y z; echo $2; set --; echo $#' },
  'trap exit': { script: 'trap "echo bye" EXIT; echo hi' },
  'background and wait': { script: '{ sleep 0.05; echo bg; } & echo fg; wait; echo done' },
  'script file': { script: './run.sh a "b c"; echo "exit $?"; sh run.sh x', files: TREE },
  'sh -c args': { script: 'sh -c \'echo "$0 $1 $#"\' name one two' },
  'syntax error': { script: 'echo ok; if then fi' },
  comments: { script: 'echo a # comment\n# full line\necho b#notcomment' },
  'line continuation': { script: 'echo a \\\n  b; x=1\\\n2; echo $x' },
  'pipes with builtins': {
    script: 'echo hello | tr a-z A-Z | rev 2>/dev/null || echo hello | tr a-z A-Z',
  },
  'yes head': { script: 'yes | head -3; yes abc | head -n 2' },
  'process substitution': {
    script: 'cat <(echo from procsub); diff <(printf "a\\nb\\n") <(printf "a\\nc\\n"); echo $?',
  },
  'locals unset in function': { script: 'f() { local v; echo "[${v-unset}]"; }; v=outer; f' },
  declare: {
    script:
      'declare -i n=5+5; echo $n; declare -x E=1; sh -c "echo \\$E"; declare -r R=1; R=2 2>/dev/null; echo $R',
  },
  'string compare in test': {
    script: '[ "abc" \\< "abd" ] && echo lt; [ "b" \\> "a" ] && echo gt',
  },
  'nested quotes in param': {
    script: 'unset x; echo "${x:-"a b"}"; echo ${x:-a\\ b}; y="q"; echo "${y:+"$y$y"}"',
  },
  'arith in index of for': { script: 'n=3; for ((i=n; i>0; i--)); do printf "%d " $i; done; echo' },
  'pushd popd': {
    script: 'pushd dir >/dev/null; basename $PWD; popd >/dev/null; basename $PWD',
    files: TREE,
  },
};

const COMMAND_CASES: Record<string, Case> = {
  cat: {
    script: 'cat a.txt nonl.txt; echo; cat -n b.txt; cat -b b.txt; cat -E a.txt; cat nope; cat dir',
    files: TREE,
  },
  'cat stdin': { script: 'echo piped | cat - a.txt', files: TREE },
  ls: {
    script:
      'ls; ls -a; ls -A dir; ls -1 dir/sub; ls -d dir; ls -F; ls -p dir; ls -R dir; ls nope; echo $?',
    files: TREE,
  },
  'ls sort': { script: 'ls -r; ls -S dir', files: TREE },
  'mkdir rmdir': {
    script:
      'mkdir -p x/y/z; ls x/y; mkdir x; echo $?; rmdir x; echo $?; rmdir -p x/y/z; ls x 2>&1; mkdir -v m1; mkdir -pv m2/n2',
  },
  touch: { script: 'touch t1 t2; ls t*; touch -c t3; ls t3; echo $?' },
  cp: {
    script:
      'cp a.txt c.txt; cat c.txt; cp a.txt dir; ls dir; cp dir d2; echo $?; cp -r dir d2; ls -R d2; cp nope x; cp a.txt b.txt dir/sub; ls dir/sub; cp a.txt a.txt',
    files: TREE,
  },
  'cp into existing dir': {
    script: 'mkdir t; cp -r dir t; ls t t/dir; cp -rv dir/sub t2',
    files: TREE,
  },
  mv: {
    script:
      'mv a.txt z.txt; ls *.txt; mv z.txt dir; ls dir; mv nope x; mv dir/z.txt .; mv dir dir2; ls; mv -v b.txt c.txt',
    files: TREE,
  },
  rm: {
    script:
      'rm a.txt; ls a.txt; rm dir; rm -r dir; ls; rm -f nope; echo $?; rm nope; rm -rv .hidden; rm -d empty; echo $?',
    files: TREE,
  },
  'rm dirs': { script: 'mkdir -p e/f; rm -d e; rm -rf e; ls; rm .; rm -rf ..', files: {} },
  ln: {
    script:
      'ln -s a.txt l1; cat l1; ln a.txt h1; ls -1; ln -s a.txt l1; ln -sf b.txt l1; readlink l1; ln -s /x dir; readlink dir/x',
    files: TREE,
  },
  chmod: {
    script:
      'chmod 600 a.txt; [ -x a.txt ] || echo noexec; chmod +x a.txt; [ -x a.txt ] && echo exec; chmod u-x,g+w a.txt; stat -c %a a.txt 2>/dev/null || true; chmod nope x; chmod 7 missing',
    files: TREE,
    stderr: false,
  },
  'head tail': {
    script:
      'head -2 a.txt; head -n 1 a.txt b.txt; tail -1 a.txt; tail -n +2 a.txt; tail -c 4 a.txt; head -c 3 a.txt; echo; head -n -1 a.txt; tail -n 2 nonl.txt; echo',
    files: TREE,
  },
  'head tail stdin': { script: 'seq 20 | head -5; seq 20 | tail -3; seq 5 | tail -n +4' },
  wc: {
    script:
      'wc a.txt; wc -l a.txt b.txt; wc -w < b.txt; wc -c nonl.txt; wc -l < a.txt; cat a.txt | wc; wc -L b.txt; wc empty',
    files: TREE,
  },
  sort: {
    script:
      'sort a.txt; sort -r a.txt; sort -n nums.txt; sort -nr nums.txt; sort -u nums.txt; sort nums.txt; sort -t, -k2 -n data.csv; sort -t, -k3,3 data.csv',
    files: TREE,
  },
  'sort keys': {
    script:
      'printf "b 2\\na 10\\nc 1\\na 2\\n" | sort -k2n; printf "b 2\\na 10\\nc 1\\na 2\\n" | sort -k1,1 -k2,2nr; printf "B\\na\\nC\\nb\\n" | sort -f; printf "1.10\\n1.9\\n1.2\\n" | sort -V; printf "2K\\n1M\\n3\\n" | sort -h',
  },
  uniq: {
    script:
      'printf "a\\na\\nb\\na\\nc\\nc\\n" > u; uniq u; uniq -c u; uniq -d u; uniq -u u; sort u | uniq -c; printf "A\\na\\n" | uniq -i',
  },
  cut: {
    script:
      'cut -d, -f1 data.csv; cut -d, -f2,3 data.csv; cut -d, -f2- data.csv; cut -c1-3 a.txt; cut -c2 a.txt; echo "a:b:c" | cut -d: -f1,3 --output-delimiter=-; echo nodelim | cut -d, -f2; echo nodelim | cut -s -d, -f2',
    files: TREE,
  },
  tr: {
    script:
      'echo hello | tr a-z A-Z; echo hello | tr -d l; echo "aa  bb" | tr -s " "; echo hello | tr el ip; echo abc | tr -c a x; echo; echo hello | tr "[:lower:]" "[:upper:]"; echo 123abc | tr -cd 0-9; echo; echo hi | tr "\\n" X; echo',
  },
  tee: { script: 'echo hi | tee t1 t2; cat t1 t2; echo more | tee -a t1 >/dev/null; cat t1' },
  grep: {
    script:
      'grep an a.txt; grep -n e a.txt; grep -c a a.txt; grep -v a a.txt; grep -i APPLE a.txt; grep -w two b.txt; grep -x six b.txt; grep -o an a.txt; grep nope a.txt; echo $?; grep -l a *.txt; grep -L zzz *.txt; grep -h a a.txt b.txt; grep -H apple a.txt',
    files: TREE,
  },
  'grep regex': {
    script:
      'grep "^b" a.txt; grep "y$" a.txt; grep -E "an+a" a.txt; grep "an\\+a" a.txt; grep -E "(ap|ch)" a.txt; grep "\\(ap\\|ch\\)" a.txt; grep -F "a.p" a.txt; echo $?; grep "[[:digit:]]" nums.txt | head -2; grep -e apple -e cherry a.txt',
    files: TREE,
  },
  'grep recursive': {
    script:
      'grep -r js dir; grep -r --include="*.ts" export .; grep -rl . dir | sort; grep -rn z dir',
    files: TREE,
  },
  'grep context': {
    script:
      'seq 10 | grep -A1 5; seq 10 | grep -B2 3; seq 20 | grep -C1 -E "^(5|15)$"; seq 10 | grep -m2 1',
  },
  'grep errors': {
    script:
      'grep x nope; echo $?; grep -q x nope a.txt; echo $?; grep "a\\(" a.txt; echo $?; grep -s x nope; echo $?',
    files: TREE,
  },
  find: {
    script:
      'find dir | sort; find . -name "*.js" | sort; find . -type d | sort; find dir -type f -name "*.ts"; find . -maxdepth 1 -type f | sort; find nope; echo $?',
    files: TREE,
  },
  'find ops': {
    script:
      'find . -name "*.js" -o -name "*.ts" | sort; find . -not -name "*.txt" -type f | sort; find dir \\( -name x.js -o -name z.js \\) | sort; find . -empty | sort; find . -path "*/sub/*"',
    files: TREE,
  },
  'find exec': {
    script:
      'find dir -name "*.js" -exec echo found {} \\; | sort; find dir -type f -exec wc -l {} + | sort; touch -d "2000-01-01 00:00" old; touch -d "2001-01-01 00:00" a.txt; find . -name "*.txt" -newer old | sort; find . -name "*.txt" ! -newer a.txt | sort; find dir -mindepth 2',
    files: TREE,
  },
  'find delete print0': {
    script:
      'find dir -name "*.js" -delete; find dir | sort; find dir -print0 | tr "\\0" "\\n" | sort; find dir -printf "%f %d\\n" | sort',
    files: TREE,
  },
  xargs: {
    script:
      'echo a b c | xargs echo x; printf "1\\n2\\n3\\n" | xargs -n 2 echo; printf "a\\nb\\n" | xargs -I{} echo "<{}>"; printf "x y\\0z\\0" | xargs -0 echo; echo | xargs echo empty; echo | xargs -r echo none; echo "\'q w\' e" | xargs -n1 echo',
  },
  'xargs status': {
    script: 'echo a | xargs false; echo $?; echo a | xargs nonexistentcmd; echo $?',
    stderr: false,
  },
  sed: {
    script:
      'sed s/a/A/ a.txt; sed s/a/A/g a.txt; sed -n 2p a.txt; sed 2d a.txt; sed -n "/an/p" a.txt; sed "1,2s/^/> /" a.txt; sed "\\$d" a.txt; sed -e s/a/1/ -e s/b/2/ a.txt; sed -E "s/(an)+/X/" a.txt; sed "s/\\(a\\)\\(p\\)/\\2\\1/" a.txt',
    files: TREE,
  },
  'sed commands': {
    script:
      'sed "2i\\\\\ninserted" a.txt; sed "2a appended" a.txt; sed "2c changed" a.txt; sed -n "\\$=" a.txt; sed "y/abc/xyz/" a.txt; sed "/banana/q" a.txt; sed -n "1!G;h;\\$p" a.txt; sed "N;s/\\n/+/" a.txt; sed "=" nonl.txt',
    files: TREE,
  },
  'sed advanced': {
    script:
      'sed "s/a/X/2" a.txt; sed "s/[aeiou]/\\U&/g" a.txt; sed "s/.*/[&]/" a.txt; sed -n "/apple/,/banana/p" a.txt; sed "0~2d" nums.txt; sed "2,+1d" nums.txt; sed ":a;s/0//;ta" nums.txt; sed "s/x*/-/g" <<< abc; sed "s|/|_|g" <<< /a/b',
    files: TREE,
  },
  'sed in-place': {
    script:
      'sed -i "s/apple/APPLE/" a.txt; cat a.txt; sed -i.bak "1d" b.txt; cat b.txt; cat b.txt.bak | head -1',
    files: TREE,
  },
  'sed errors': {
    script: 'sed "s/a/b" a.txt; echo $?; sed nope a.txt; echo $?; sed p missing; echo $?',
    files: TREE,
    stderr: false,
  },
  diff: {
    script:
      'printf "a\\nb\\nc\\n" > 1; printf "a\\nB\\nc\\nd\\n" > 2; diff 1 2; echo $?; diff 1 1; echo $?; diff -q 1 2; diff missing 1; echo $?',
  },
  'diff unified': {
    script:
      'printf "1\\n2\\n3\\n4\\n5\\n6\\n7\\n8\\n9\\n" > a; printf "1\\n2\\nX\\n4\\n5\\n6\\n7\\n8\\nY\\n" > b; diff -u a b | tail -n +3; diff -U1 a b | tail -n +3',
  },
  'diff nonl': { script: 'printf "a\\nb" > x; printf "a\\nb\\n" > y; diff x y; diff y x' },
  'diff dirs': {
    script:
      'mkdir -p p q; echo 1 > p/f; echo 2 > q/f; echo o > p/only; diff p q; diff -r p q; echo $?',
  },
  seq: { script: 'seq 3; seq 2 4; seq 1 2 7; seq 5 -2 1; seq -s, 3; seq -w 8 10; seq 0.5 0.5 2' },
  'basename dirname': {
    script:
      'basename /a/b/c.txt; basename /a/b/c.txt .txt; basename a/; dirname /a/b/c; dirname a; dirname /; dirname a/b/; basename -a x/y z/w',
  },
  'realpath readlink': {
    script:
      'realpath a.txt | sed "s|$PWD|.|"; realpath link | sed "s|$PWD|.|"; readlink link; readlink -f link | sed "s|$PWD|.|"; readlink a.txt; echo $?; realpath nope/x; echo $?',
    files: TREE,
  },
  env: {
    script:
      'env -i A=1 B=2 env | sort; env -u HOME sh -c "echo \\${HOME-gone}"; FOO=bar env | grep ^FOO',
  },
  which: { script: 'which nonexist; echo $?; command -v sh >/dev/null && echo has-sh' },
  'true false': { script: 'true; echo $?; false; echo $?; /bin/sh -c "exit 3"; echo $?' },
  'pipeline fanout': {
    script: 'cat data.csv | grep -v name | cut -d, -f3 | sort | tr a-z A-Z | head -2',
    files: TREE,
  },
  mktemp: {
    script:
      'f=$(mktemp); [ -f "$f" ] && echo file; d=$(mktemp -d); [ -d "$d" ] && echo dir; mktemp -p . xXXXXX | grep -c "^./x"',
  },
  'date format': {
    script:
      'date -d @0 +%Y-%m-%d; date -u -d @86400 "+%H:%M:%S %j %a %b"; date -d "2024-02-29" +%F',
  },
};

const PROJECT: FileTree = {
  'package.json':
    '{\n  "name": "demo",\n  "version": "1.0.0",\n  "scripts": { "build": "vite build" }\n}\n',
  'src/index.js': 'import x from "./util.js";\n// TODO: fix\nconsole.log(x);\n',
  'src/util.js': 'export default 42;\n// TODO later\n',
  'src/app.css': 'body { margin: 0; }\r\n',
  'node_modules/dep/index.js': 'module.exports = 1;\n',
  'README.md': '# Demo\n\nSome text.\n',
};

const AGENT_CASES: Record<string, Case> = {
  'scaffold with heredoc': {
    script:
      'mkdir -p app/src && cd app && cat > src/main.js <<\'EOF\'\nconst x = `${1 + 1}`;\nconsole.log("hi $HOME");\nEOF\ncat src/main.js; ls -R',
  },
  'strict mode script': {
    script:
      'set -euo pipefail\ncleanup() { echo "cleanup $?"; }\ntrap cleanup EXIT\nname=${1:-default}\necho "name=$name"\n[ -d src ] && echo has-src\nfalse\necho unreachable',
    files: PROJECT,
  },
  'project grep and find': {
    script:
      'grep -rn TODO src | sort; find . -name node_modules -prune -o -name "*.js" -print | sort; grep -c "" src/*.js',
    files: PROJECT,
  },
  'json-ish extraction': {
    script:
      'grep \'"name"\' package.json | sed -E \'s/.*"name": "([^"]+)".*/\\1/\'; cat package.json | tr -d " " | grep -o \'"version":"[^"]*"\'',
    files: PROJECT,
  },
  'sed in place across files': {
    script:
      'for f in src/*.js; do sed -i "s/TODO/DONE/g" "$f"; done; grep -h DONE src/*.js; tr -d "\\r" < src/app.css | wc -c',
    files: PROJECT,
  },
  'counting pipeline': {
    script:
      'printf "b\\na\\nb\\nc\\nb\\na\\n" | sort | uniq -c | sort -rn; ls src | wc -l; find src -type f | xargs wc -l | tail -1',
    files: PROJECT,
  },
  'conditional install': {
    script:
      'if [ ! -d node_modules/missing ]; then echo "would install"; fi; command -v nonexistent-tool >/dev/null 2>&1 || echo "tool missing"; test -f package.json && echo pkg',
    files: PROJECT,
  },
  'dirname of $0 style': {
    script:
      'printf \'#!/bin/bash\\nDIR="$(cd "$(dirname "$0")" && pwd)"\\nbasename "$DIR"\\necho "${BASH_SOURCE:-x}" >/dev/null\\n\' > tools/s.sh; chmod +x tools/s.sh; ./tools/s.sh',
    files: { 'tools/.keep': '' },
  },
  'appending and counting': {
    script:
      'for i in $(seq 1 5); do echo "line $i" >> log.txt; done; wc -l < log.txt; tail -n 2 log.txt; : > log.txt; wc -c < log.txt',
  },
  'env and export': {
    script:
      "export NODE_ENV=production; sh -c 'echo $NODE_ENV'; NODE_ENV=dev sh -c 'echo $NODE_ENV'; echo $NODE_ENV; unset NODE_ENV; sh -c 'echo \"[${NODE_ENV-}]\"'",
  },
  'arrays of words via set': {
    script: 'files="a b c"; set -- $files; echo $#; for f; do printf "%s," "$f"; done; echo',
  },
  'case with patterns from vars': {
    script:
      'ext=js; for f in a.js b.ts c.css; do case "$f" in *.$ext) echo "$f js";; *.ts|*.tsx) echo "$f ts";; *) echo "$f other";; esac; done',
  },
  'while read with pipes': {
    script:
      'printf "a 1\\nb 2\\nc 3\\n" | while read -r name n; do echo "$name=$((n * 10))"; done; count=0; while read -r line; do count=$((count+1)); done < package.json; echo $count',
    files: PROJECT,
  },
  'string ops': {
    script:
      'f=src/components/Button.test.tsx; echo ${f##*/} ${f%/*} ${f%%.*} ${f#*.}; name=${f##*/}; echo ${name%%.*}; up=$(echo $name | tr a-z A-Z); echo $up',
  },
  'nested command substitution quoting': {
    script:
      'echo "$(echo "inner \\"quoted\\" $(echo deeper)")"; x="$(printf "%s" "a  b")"; echo "[$x]"',
  },
  'subshell cd': {
    script:
      '(cd src && ls) ; pwd | sed "s|.*/||"; (cd /nonexistent 2>/dev/null) || echo "cd failed"',
    files: PROJECT,
  },
  'exit codes propagate': {
    script:
      'sh -c "exit 7"; echo $?; (exit 3) || echo "sub failed $?"; f() { return 4; }; if ! f; then echo "f failed"; fi',
  },
  'long loop': {
    script:
      'i=0; s=0; while [ $i -lt 500 ]; do i=$((i+1)); s=$((s+i)); done; echo $s; for x in $(seq 1 300); do :; done; echo done',
  },
  'heredoc in function and loop': {
    script: 'gen() { cat <<EOF\nfile: $1\nEOF\n}; for n in a b; do gen $n; done',
  },
  'redirect inside loop': {
    script:
      'for i in 1 2 3; do echo $i; done > nums; cat nums; while read n; do echo "got $n"; done < nums | tail -1',
  },
  'quoted special chars': {
    script:
      'echo "tab:\tnl:\\n" \'single $x\' "dollar \\$x" "back\\`tick\\`"; echo "a"\\\'b\\\'"c"',
  },
  'edge: grep -r without operand': {
    script: 'cd dir && grep -rn . | sort; grep -r --exclude-dir=sub -l . | sort',
    files: TREE,
  },
  'edge: sed zero address and ranges': {
    script:
      'printf "a\\nb\\na\\n" | sed "0,/a/s//X/"; seq 6 | sed -n "2,4!p"; seq 5 | sed "/2/,/4/d"; seq 3 | sed -n "\\$!p"',
  },
  'edge: read variants': {
    script:
      'printf "  lead  trail  \\n" | { IFS= read -r x; echo "[$x]"; }; printf "  lead  trail  \\n" | { read -r x; echo "[$x]"; }; printf "a:b:c" | { IFS=: read -r p q; echo "$p|$q"; }',
  },
  'edge: break in pipeline stage': {
    script:
      'for i in 1 2 3; do echo $i; if [ $i = 2 ]; then break; fi; done | cat; echo "x" | while read l; do echo "in $l"; done; echo end',
  },
  'printf table': {
    script:
      'printf "%-10s|%5s\\n" name size; for f in a.txt b.txt; do printf "%-10s|%5d\\n" "$f" "$(wc -c < $f)"; done',
    files: TREE,
  },
};

async function compare(c: Case) {
  const real = runReal(c.script, c.files ?? {}, c.stdin === undefined ? {} : { stdin: c.stdin });
  const ours = await runOurs(
    c.script,
    c.files ?? {},
    real.dir,
    c.stdin === undefined ? {} : { stdin: c.stdin },
  );
  const norm = (s: string) => s.replaceAll(real.dir, '<DIR>');
  const pick = (r: { code: number; stdout: string; stderr: string }) => ({
    code: r.code,
    stdout: norm(r.stdout),
    ...(c.stderr === false ? {} : { stderr: norm(r.stderr) }),
  });
  expect(pick(ours)).toEqual(pick(real));
}

describe('shell differential vs bash', () => {
  for (const [name, c] of Object.entries(SHELL_CASES)) it(name, () => compare(c));
});

describe('commands differential vs GNU coreutils', () => {
  for (const [name, c] of Object.entries(COMMAND_CASES)) it(name, () => compare(c));
});

describe('agent-style scripts differential vs bash', () => {
  for (const [name, c] of Object.entries(AGENT_CASES)) it(name, () => compare(c));
});
