// Where a project lives: GitHub, or a GitLab (gitlab.com, or a self-managed one). Shared by the
// server, which talks to each with its own CLI (`gh`, `glab`), and the client, which words things
// the way each one does ("pull request" or "merge request").

export type ForgeKind = 'github' | 'gitlab';

/** What a forge calls things, and what the office runs to talk to it. */
export interface ForgeMeta {
  kind: ForgeKind;
  name: string;
  /** The command-line tool the office drives it with. */
  cli: string;
  /** "PR" or "MR". */
  pr: string;
  /** "pull request" or "merge request". */
  pullRequest: string;
  /** What a link to pull request `n` looks like in a description or a comment. */
  ref(repoPath: string, n: number): string;
}

export const FORGES: Record<ForgeKind, ForgeMeta> = {
  github: { kind: 'github', name: 'GitHub', cli: 'gh', pr: 'PR', pullRequest: 'pull request', ref: (repo, n) => `${repo}#${n}` },
  gitlab: { kind: 'gitlab', name: 'GitLab', cli: 'glab', pr: 'MR', pullRequest: 'merge request', ref: (repo, n) => `${repo}!${n}` },
};

export const GITHUB_HOST = 'github.com';
export const GITLAB_HOST = 'gitlab.com';

/** GitLab hosts besides gitlab.com (and the ones named gitlab.*), as the server was told of them. */
const extraHosts = new Set<string>();

/** The office was told of self-managed GitLabs (AGENT_OFFICE_GITLAB_HOSTS): these hosts are GitLab too. */
export function setGitlabHosts(hosts: string[]) {
  extraHosts.clear();
  for (const h of hosts) {
    const host = h.trim().toLowerCase();
    if (/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/.test(host) && host.includes('.')) extraHosts.add(host);
  }
}

export function gitlabHosts(): string[] {
  return [GITLAB_HOST, ...extraHosts];
}

export function isGitlabHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === GITLAB_HOST || extraHosts.has(h) || /^gitlab\./.test(h);
}

/** A repository, taken apart. `repo` is how the office names it everywhere (see parseRepo). */
export interface RepoRef {
  kind: ForgeKind;
  host: string;
  /** owner/name on GitHub; group/subgroup/…/project on GitLab. */
  path: string;
  repo: string;
}

/** A path segment of a GitHub repository's name, or of a GitLab group or project. */
const GITHUB_OWNER = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const GITHUB_NAME = /^[a-zA-Z0-9_.-]{1,100}$/;
const GITLAB_SEGMENT = /^[a-zA-Z0-9_](?:[a-zA-Z0-9_.-]{0,254})$/;
/** Where a GitLab page's address goes on past the project (…/group/project/-/issues/12, or the older …/project/issues/12). */
const PAGE_WORDS = new Set(['issues', 'merge_requests', 'pipelines', 'tree', 'blob', 'commits', 'wikis', 'jobs']);

/**
 * A repository from what someone typed or pasted, or undefined for anything else, so it can never
 * become a CLI option, a path or another host:
 *   owner/name                          GitHub, as it has always been typed
 *   github.com/owner/name, https://… or git@github.com:owner/name.git
 *   gitlab.com/group/sub/project, https://… or git@gitlab.com:group/project.git (any GitLab host the office knows)
 * A GitHub repository is named `owner/name`; any other is named `host/path` (a GitHub owner can't
 * have a dot in it, so the two can never be mistaken for each other).
 */
export function parseRepo(value: unknown): RepoRef | undefined {
  if (typeof value !== 'string') return undefined;
  let s = value.trim();
  if (s.length > 300) return undefined;
  s = s.replace(/[?#].*$/, '').replace(/^(?:https?:\/\/|ssh:\/\/|git:\/\/)/i, '');
  // Whoever it logs in as (git@, oauth2:token@) is not part of the name.
  const slash = s.indexOf('/');
  const at = (slash < 0 ? s : s.slice(0, slash)).lastIndexOf('@');
  if (at >= 0) s = s.slice(at + 1);
  s = s.replace(/\/+$/, '');
  // host:path (scp-style) or host/path; a port in an ssh:// URL (host:2222/path) is dropped.
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::\d{1,5})?[/:](.+)$/.exec(s);
  const dotted = m && m[1].includes('.');
  if (!dotted) return parseSegments('github', GITHUB_HOST, s);
  const host = m![1].toLowerCase();
  const rest = m![2];
  if (host === GITHUB_HOST) return parseSegments('github', GITHUB_HOST, rest);
  if (isGitlabHost(host)) return parseSegments('gitlab', host, rest);
  return undefined;
}

function parseSegments(kind: ForgeKind, host: string, rest: string): RepoRef | undefined {
  let parts = rest.replace(/\.git$/i, '').split('/');
  if (kind === 'github') {
    // A URL may go on past the repository (…/owner/repo/issues/12).
    if (parts.length < 2) return undefined;
    const [owner, name] = parts;
    if (!GITHUB_OWNER.test(owner) || !GITHUB_NAME.test(name) || name === '.' || name === '..') return undefined;
    return { kind, host, path: `${owner}/${name}`, repo: `${owner}/${name}` };
  }
  const dash = parts.indexOf('-');
  if (dash >= 0) parts = parts.slice(0, dash);
  const page = parts.findIndex((p, i) => i >= 2 && PAGE_WORDS.has(p));
  if (page >= 0) parts = parts.slice(0, page);
  parts = parts.map((p, i) => (i === parts.length - 1 ? p.replace(/\.git$/i, '') : p));
  if (parts.length < 2 || parts.length > 20) return undefined;
  if (!parts.every((p) => GITLAB_SEGMENT.test(p) && p !== '.' && p !== '..' && !p.endsWith('.git') && !p.endsWith('.atom'))) return undefined;
  const p = parts.join('/');
  return { kind, host, path: p, repo: `${host}/${p}` };
}

/** Which forge a repository name (as the office keeps it) is on. */
export function forgeOf(repo: string | undefined): ForgeKind {
  return repo && /^[^/]+\.[^/]+\//.test(repo) && !repo.startsWith(`${GITHUB_HOST}/`) ? 'gitlab' : 'github';
}

export function forgeMeta(repo: string | undefined): ForgeMeta {
  return FORGES[forgeOf(repo)];
}

/** The host a repository is on. */
export function repoHost(repo: string): string {
  return forgeOf(repo) === 'gitlab' ? repo.slice(0, repo.indexOf('/')) : GITHUB_HOST;
}

/** A repository's path on its host: owner/name, or group/…/project. */
export function repoPath(repo: string): string {
  return forgeOf(repo) === 'gitlab' ? repo.slice(repo.indexOf('/') + 1) : repo;
}

/** The folders a project is cloned into under the projects folder: <owner>/<name>, or <host>/<group>/…/<project>. */
export function repoFolders(repo: string): string[] {
  return repo.split('/');
}

/** The address of a repository's page. */
export function repoUrl(repo: string): string {
  return `https://${repoHost(repo)}/${repoPath(repo)}`;
}

/** Which forge a web address is on: github.com, or else a GitLab (the only other one the office knows). */
export function forgeOfUrl(url: string): ForgeKind {
  try {
    return new URL(url).hostname.toLowerCase() === GITHUB_HOST ? 'github' : 'gitlab';
  } catch {
    return 'github';
  }
}

/** The pages of a project on a forge: GitLab's all sit under /-/. */
const PAGES: Record<ForgeKind, Record<'issue' | 'pull' | 'blob' | 'labels', string>> = {
  github: { issue: 'issues', pull: 'pull', blob: 'blob', labels: 'labels' },
  gitlab: { issue: '-/issues', pull: '-/merge_requests', blob: '-/blob', labels: '-/labels' },
};

/** The address of a page of the project at `repoWeb` (https://host/owner/name): an issue or pull request by number, a file at `HEAD/path`, or the labels. */
export function forgePage(repoWeb: string, page: 'issue' | 'pull' | 'blob' | 'labels', rest?: string | number): string {
  return `${repoWeb}/${PAGES[forgeOfUrl(repoWeb)][page]}${rest === undefined || rest === '' ? '' : `/${rest}`}`;
}

/** The project's web address from the address of one of its issues or pull requests. */
export function repoWebOfItem(itemUrl: string): string {
  return itemUrl.replace(/\/(?:-\/)?(?:pull|issues|merge_requests)\/\d+.*$/, '');
}

/** The web address of the project a git remote points at (https://, ssh or git@), when it's on a forge the office knows. */
export function repoWebOfRemote(remote: string | undefined): string | undefined {
  const r = parseRepo(remote);
  return r ? repoUrl(r.repo) : undefined;
}
