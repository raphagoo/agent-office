import type { ForgeKind } from '../shared/forge.js';
import { quote } from './signins-util.js';

// An account's git config (see signins.ts): the office machine's own, with each forge's CLI as the
// credentials for its host, so pushes go out as the account, and the account's name and private email
// on commits once they're known. With both a GitHub and a GitLab login, commits to a GitLab remote
// carry the GitLab identity (a second file, included when a remote points at a GitLab host).

export interface GitUser {
  name: string;
  email: string;
}

export interface GitConfigInput {
  /** The office's own git config files. */
  includes: string[];
  /** The forge CLIs that are installed (path), and the GitLab hosts there are credentials for. */
  bins: Partial<Record<ForgeKind, string>>;
  gitlabHosts: string[];
  users: Partial<Record<ForgeKind, GitUser>>;
  /** Where the second file will be written (included from the first when both forges have an identity). */
  gitlabFile: string;
}

const shellQuote = (bin: string) => `'${bin.replace(/'/g, `'\\''`)}'`;

/** The text of the account's git config, and of the GitLab identity file that goes with it (when there is one). */
export function gitConfigText(i: GitConfigInput): { main: string; gitlab?: string } {
  const lines = ['# Written by Agent Office: git for this account, on top of the office machine’s own settings.', '[include]', ...i.includes.map((p) => `\tpath = ${quote(p)}`)];
  const helper = (host: string, bin: string) => lines.push(`[credential ${quote(host)}]`, '\thelper =', `\thelper = ${quote(`!${shellQuote(bin)} auth git-credential`)}`);
  if (i.bins.github) for (const host of ['https://github.com', 'https://gist.github.com']) helper(host, i.bins.github);
  if (i.bins.gitlab) for (const host of i.gitlabHosts) helper(`https://${host}`, i.bins.gitlab);
  const user = (u: GitUser) => ['[user]', `\tname = ${quote(u.name)}`, `\temail = ${quote(u.email)}`];
  const { github, gitlab } = i.users;
  const first = github ?? gitlab;
  if (first) lines.push(...user(first));
  let second: string | undefined;
  if (github && gitlab) {
    for (const host of i.gitlabHosts) for (const url of [`https://${host}/**`, `git@${host}:**`, `ssh://git@${host}/**`]) lines.push(`[includeIf ${quote(`hasconfig:remote.*.url:${url}`)}]`, `\tpath = ${quote(i.gitlabFile)}`);
    second = `${['# Written by Agent Office: the GitLab identity, for remotes on GitLab.', ...user(gitlab)].join('\n')}\n`;
  }
  return { main: `${lines.join('\n')}\n`, gitlab: second };
}
