# @clientvm/shell

The ClientVM shell (`sh`/`bash`) and Linux commands, implemented in TypeScript.

- `parse`: POSIX shell grammar plus common bash extensions, to an AST (`ast.ts`).
- `Shell`: the interpreter. Builtins and the commands in `commands/` run in-process;
  anything else (`node`, scripts, `node_modules/.bin` shims) is spawned through the kernel.
- `shellRuntimes`: the `sh`/`bash` runtime plus one runtime per command, so
  `child_process.spawn('ls')` works as on Linux.

See docs/compatibility.md for the supported surface.
