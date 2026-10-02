import { forgeText } from '../../shared/forge-text.js';
import { forgeOf, type ForgeKind } from '../../shared/forge.js';
import { githubOps, GithubForge } from './github.js';
import { gitlabOps, GitlabForge } from './gitlab.js';
import { originRepo } from './origin.js';
import type { Forge, ForgeOps } from './types.js';

export { gh, glab } from './cli.js';
export { originRepo } from './origin.js';
export type * from './types.js';

export function opsOf(kind: ForgeKind): ForgeOps {
  return kind === 'gitlab' ? gitlabOps : githubOps;
}

/** What the office does with the forge a checkout's origin is on. A checkout with no origin the office knows is treated as GitHub's, which says so when asked. */
export function opsForDir(dir: string): ForgeOps {
  return opsOf(forgeOf(originRepo(dir)));
}

/** The boards of the repository `dir` is a checkout of (or `repo`, when it's known). */
export function forgeFor(dir: string, repo?: string): Forge {
  const name = repo ?? originRepo(dir);
  return name && forgeOf(name) === 'gitlab' ? new GitlabForge(name, dir) : new GithubForge(dir);
}

/** Which forge the project in `dir` is on, for what its prompts should speak of. */
export function projectForge(dir: string): ForgeKind {
  return forgeOf(originRepo(dir));
}

/** `text` (a prompt, or a line of one) in the words of the forge the project in `dir` is on. */
export function projectText(dir: string, text: string): string {
  return forgeText(text, projectForge(dir));
}
