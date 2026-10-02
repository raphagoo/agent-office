import { execFile } from 'node:child_process';

// The two command-line tools the office drives, run to the end with what they said turned into
// something a person standing at the board can act on.

/** What a command-line tool printed on stderr that says it isn't signed in. */
const SIGNED_OUT = /auth login|not logged in|authentication|401|unauthorized|invalid[_ ]token|no token/i;

export interface RunOptions {
  cwd?: string;
  timeout?: number;
  /** Someone signed in to their own account (see signins.ts); unset, the office's own environment. */
  env?: Record<string, string>;
  /** Written to its stdin, then closed. */
  input?: string;
}

interface Raw {
  err: (Error & { code?: number | string }) | null;
  stdout: string;
  stderr: string;
}

function exec(cmd: string, args: string[], o: RunOptions): Promise<Raw> {
  return new Promise((resolve) => {
    const p = execFile(cmd, args, { cwd: o.cwd, maxBuffer: 32 * 1024 * 1024, timeout: o.timeout ?? 30_000, env: o.env }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
    if (o.input !== undefined) p.stdin?.end(o.input);
  });
}

/** Turns gh's stderr into something a person standing at the board can act on. */
function friendly(raw: string): string {
  if (/no git remotes found|none of the git remotes/i.test(raw)) return 'This project has no GitHub remote yet. Push it to GitHub (git remote add origin <url>) to fill the boards.';
  if (/not a git repository/i.test(raw)) return "This folder isn't a git repository";
  if (/auth login|not logged in|authentication/i.test(raw)) return "gh isn't signed in to GitHub on the office's machine — run `gh auth login` there";
  if (/could not resolve to a repository|not found/i.test(raw)) return "gh can't find this repository on GitHub (check the remote and access)";
  return raw;
}

/** Runs gh as the office, or with `env` as someone signed in to their own GitHub (see signins.ts). */
export function gh(args: string[], cwd: string, timeout = 30_000, env?: Record<string, string>, input?: string): Promise<string> {
  return exec('gh', args, { cwd, timeout, env, input }).then(({ err, stdout, stderr }) => {
    if (!err) return stdout;
    const msg = (stderr || err.message || '').trim().split('\n').slice(-2).join(' ');
    const signedOut = env && /auth login|not logged in|authentication/i.test(msg);
    throw new Error(err.code === 'ENOENT' ? 'GitHub CLI (gh) is not installed on the server' : signedOut ? 'Your GitHub sign-in stopped working — sign in again (☰ → 🔐 Your sign-ins)' : friendly(msg));
  });
}

/** What GitLab said went wrong: its own message (in the body glab prints), else the last of what glab said. */
export function gitlabError(stdout: string, stderr: string, fallback: string): string {
  let said = '';
  try {
    const body = JSON.parse(stdout) as { message?: unknown; error?: unknown; error_description?: unknown };
    const m = body.message ?? body.error_description ?? body.error;
    said = typeof m === 'string' ? m : m && typeof m === 'object' ? Object.entries(m as Record<string, unknown>).map(([k, v]) => `${k} ${[v].flat().join(', ')}`).join('; ') : '';
  } catch {
    // not a JSON body: glab's own words
  }
  const lines = stderr.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return (said || lines.slice(-2).join(' ') || fallback).slice(0, 400);
}

function friendlyGitlab(raw: string): string {
  if (/not a git repository/i.test(raw)) return "This folder isn't a git repository";
  if (/no git remotes|none of the git remotes|could not determine the (base )?repo/i.test(raw)) return 'This project has no GitLab remote yet. Push it to GitLab (git remote add origin <url>) to fill the boards.';
  if (SIGNED_OUT.test(raw)) return "glab isn't signed in to GitLab on the office's machine — run `glab auth login` there";
  if (/404 .*not found|project not found/i.test(raw)) return "glab can't find this repository on GitLab (check the remote and access)";
  return raw;
}

/**
 * Runs glab as the office, or with `env` as someone signed in to their own GitLab (see signins.ts).
 * Resolves to what it printed.
 */
export function glab(args: string[], o: RunOptions = {}): Promise<string> {
  return exec('glab', args, { ...o, timeout: o.timeout ?? 30_000 }).then(({ err, stdout, stderr }) => {
    if (!err) return stdout;
    if (err.code === 'ENOENT') throw new Error('GitLab CLI (glab) is not installed on the server');
    const msg = friendlyGitlab(gitlabError(stdout, stderr, err.message || 'glab failed'));
    // Their own token went bad (revoked, expired): say where to fix it, not what GitLab's 401 was.
    if (o.env && SIGNED_OUT.test(msg)) throw new Error('Your GitLab sign-in stopped working — sign in again (☰ → 🔐 Your sign-ins)');
    throw new Error(msg);
  });
}
