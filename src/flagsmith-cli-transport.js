// CLI transport: a fetch-compatible function that sends each Admin API call through the real
// Flagsmith CLI, `flagsmith api <path> -X <method> -i --no-input [--input -]`. The CLI applies
// its own stored login (`flagsmith login`), so ExperimentPilot never holds an admin token, and
// the agent never sees one.
//
// Verified on flagsmith v2.0.0 (2026-11-27, notes/flagsmith-calls.md calls 92-99):
//   success: exit 0, stdout = status line, headers, blank line, body (line endings may be mixed)
//   HTTP error: exit 1, stdout empty, stderr = body, then "Error: <METHOD> <url> returned <code> <text>"
//     (that url includes the environment key: the client redacts every message)
//   other failure (not logged in, network): exit 1, stderr "Error: ..." without "returned <code>"
// The npm package's `flagsmith` wrapper (index.js) spawns the native binary and never passes its
// exit code back, so failures look like success through it. This transport therefore runs the
// native binary: FLAGSMITH_BIN, else the @flagsmith/cli devDependency's platform package, else
// `flagsmith` on PATH (a native install, e.g. Homebrew; not on Windows, where PATH has the wrapper).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const DEFAULT_API = 'https://api.flagsmith.com';
const TIMEOUT_MS = 60_000;

const PLATFORM = { win32: 'windows', linux: 'linux', darwin: 'darwin' };
const ARCH = { x64: 'amd64', arm64: 'arm64' };

export function resolveFlagsmithBin(env = process.env) {
  if (env.FLAGSMITH_BIN) return env.FLAGSMITH_BIN;
  const pkg = `@flagsmith/cli_${PLATFORM[process.platform]}_${ARCH[process.arch]}`;
  const exe = process.platform === 'win32' ? 'flagsmith.exe' : 'flagsmith';
  const require = createRequire(import.meta.url);
  for (const from of [null, '@flagsmith/cli/package.json']) {
    try {
      const base = from ? createRequire(require.resolve(from)) : require;
      return join(dirname(base.resolve(`${pkg}/package.json`)), exe);
    } catch { /* try the next place */ }
  }
  return process.platform === 'win32' ? null : 'flagsmith';
}

export function cliArgs(url, { method = 'GET', body } = {}) {
  const args = ['api', `${url.pathname.replace(/^\//, '')}${url.search}`, '-X', method, '-i', '--no-input'];
  if (url.origin !== DEFAULT_API) args.push('--api-url', url.origin);
  if (body !== undefined) args.push('--input', '-');
  return args;
}

export function parseIncluded(stdout) {
  const status = stdout.match(/^HTTP\/[\d.]+ (\d{3})\b/);
  if (!status) throw new Error('flagsmith api -i printed no HTTP status line');
  const gap = stdout.search(/\r?\n\r?\n/);
  const body = gap === -1 ? '' : stdout.slice(gap).replace(/^\r?\n\r?\n/, '');
  return { status: Number(status[1]), body };
}

export function parseFailure(stderr) {
  const m = stderr.match(/(?:^|\n)Error: [A-Z]+ \S+ returned (\d{3})\b/);
  if (!m) return null;
  return { status: Number(m[1]), body: stderr.slice(0, m.index).trim() };
}

function run(bin, args, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`flagsmith CLI timed out after ${TIMEOUT_MS / 1000} s`)); }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input ?? '');
  });
}

const response = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => body });

// Returns a fetch(url, { method, body }) for createClient. Headers are ignored: the CLI sets
// its own Authorization and Content-Type.
export function createCliFetch({ env = process.env, bin = resolveFlagsmithBin(env) } = {}) {
  return async (url, init = {}) => {
    if (!bin) throw new Error('Flagsmith CLI binary not found: run npm ci (installs @flagsmith/cli) or set FLAGSMITH_BIN to the native flagsmith binary');
    const u = url instanceof URL ? url : new URL(url);
    const { code, stdout, stderr } = await run(bin, cliArgs(u, init), init.body, env);
    if (code === 0) {
      const ok = parseIncluded(stdout);
      return response(ok.status, ok.body);
    }
    const failed = parseFailure(stderr);
    if (failed) return response(failed.status, failed.body);
    throw new Error(`flagsmith CLI failed: ${stderr.trim().split(/\r?\n/).slice(0, 2).join(' ')}`);
  };
}
