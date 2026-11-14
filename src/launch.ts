import path from 'node:path';
import process from 'node:process';

export interface Launch {
  argv: string[];
  execPath: string;
  execArgv: string[];
  cwd: string;
  pathEnv: string;
}

function currentLaunch(): Launch {
  return {
    argv: process.argv,
    execPath: process.execPath,
    execArgv: process.execArgv,
    cwd: process.cwd(),
    pathEnv: process.env.PATH ?? '',
  };
}

/** relative path when `p` is inside `cwd`, absolute otherwise: `../../../x` is hard to read */
export function displayPath(p: string, cwd: string = process.cwd()): string {
  const rel = path.relative(cwd, p);
  return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? path.resolve(p) : rel;
}

// `bun build --compile` reports the embedded script as argv[1]; the real binary is execPath
const BUN_EMBEDDED = /^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/;

/**
 * The words that start this program again, as the user would type them:
 * `subs-translate` when found via PATH, `./dist/subs-translate-linux-x64` for a binary,
 * `node bin/subs-translate.ts` for a script.
 */
export function programWords(launch: Launch = currentLaunch()): string[] {
  const script = launch.argv[1] ?? '';
  const compiled = BUN_EMBEDDED.test(script);
  const file = compiled ? launch.execPath : script;
  const pathDirs = launch.pathEnv
    .split(path.delimiter)
    .filter(Boolean)
    .map((d) => path.resolve(d));
  if (pathDirs.includes(path.dirname(file))) return [path.basename(file)];

  const shown = displayPath(file, launch.cwd);
  if (compiled) return [shown.includes(path.sep) ? shown : `.${path.sep}${shown}`];
  return [path.basename(launch.execPath), ...launch.execArgv, shown];
}

export function quoteArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

export function formatCommand(argv: string[], program: string[] = programWords()): string {
  return [...program, ...argv].map(quoteArg).join(' ');
}
