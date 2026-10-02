import { execFileSync } from 'node:child_process';
import { normalizeRepo } from '../../shared/floors.js';

/**
 * The repository a checkout's origin points at, as the office names it (owner/name on GitHub,
 * host/group/…/project on a GitLab it knows), or undefined when it has none or lives somewhere else.
 */
export function originRepo(dir: string): string | undefined {
  try {
    return normalizeRepo(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim());
  } catch {
    return undefined;
  }
}
