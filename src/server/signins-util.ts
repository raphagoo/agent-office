import { execFile } from 'node:child_process';

// Small things the sign-ins (signins.ts) are made of: reading what a command-line tool printed in
// a terminal, running one to the end, and quoting a value for a git config file.

const LOOK_TIMEOUT_MS = 30_000;

/** A value for a git config file, quoted. */
export function quote(v: string): string {
  return `"${v.replace(/[\p{C}]/gu, '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Terminal output as plain text: no colors, links or cursor moves. */
export function plain(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r\n?/g, '\n');
}

/** The last thing a command said, minus the link and the prompt, for an error line. */
export function lastWords(s: string): string {
  const lines = plain(s)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/https?:\/\/|paste code|opening browser|press enter/i.test(l));
  return (lines.at(-1) ?? '').slice(0, 300);
}

/** Runs a command to the end; never rejects. `last` is the last line it said on stderr (or stdout). */
export function run(cmd: string, args: string[], env: Record<string, string>, input?: string): Promise<{ code: number; out: string; last: string }> {
  return new Promise((resolve) => {
    const p = execFile(cmd, args, { env, timeout: LOOK_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const e = err as { code?: number | string } | null;
      const code = !e ? 0 : typeof e.code === 'number' ? e.code : -1;
      const last = lastWords(stderr || (err && !stdout ? err.message : ''));
      resolve({ code, out: stdout.trim(), last });
    });
    if (input !== undefined) p.stdin?.end(input);
    else p.stdin?.end();
  });
}

/** Stops a process the office started, whether it ever started or is gone already. */
export function kill(p: { kill(): unknown }) {
  try {
    p.kill();
  } catch {
    // never started, or already gone
  }
}
