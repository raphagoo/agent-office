import type { ForgeKind } from '../../shared/forge.js';
import type { GhCheck, GhCloseReason, GhComment, GhIssue, GhLabel, GhMergeMethod, GhPull, GhRepoInfo, GhReviewComment, RepoChoice } from '../../shared/protocol.js';

/*
 * Forges
 * ------
 * Where a project lives is GitHub or GitLab, and the office drives each with its own command-line
 * tool (`gh`, `glab`). A Forge is one repository's issues and pull requests (merge requests on
 * GitLab) in the shapes the boards and windows show, whichever it is; ForgeOps is what the office does
 * with a forge that isn't about one repository's boards: opening a pull request from a checkout,
 * finding and cloning repositories. Numbers are GitHub's `number` and GitLab's `iid`.
 */

/** Who an action is done as: someone's own sign-in (see signins.ts), else the office's. */
export type ForgeEnv = Record<string, string> | undefined;

export interface PullDetailData {
  number: number;
  body: string;
  state: string;
  isDraft: boolean;
  reviewDecision: string;
  headRefName: string;
  baseRefName: string;
  mergeable: string;
  mergeStateStatus: string;
  commits: number;
  comments: GhComment[];
  reviews: GhComment[];
  reviewComments: GhReviewComment[];
  checks: GhCheck[];
}

export interface IssueDetailData {
  number: number;
  state: string;
  body: string;
  comments: GhComment[];
}

export interface CloseOptions {
  comment?: string;
  reason?: GhCloseReason;
  deleteBranch?: boolean;
}

/** One repository's boards and what's done to them. Every method rejects with a sentence for whoever's at the board. */
export interface Forge {
  readonly kind: ForgeKind;
  /** The repository's name there and how it lets pull requests merge. */
  repoInfo(): Promise<GhRepoInfo>;
  /** Who the office's own sign-in is, which is who it comments as for everyone without their own. */
  viewer(): Promise<string>;
  /** Open issues, then recently closed ones. */
  issues(): Promise<GhIssue[]>;
  /** Open pull requests, then recently merged and closed ones. */
  pulls(): Promise<GhPull[]>;
  pullDetail(n: number): Promise<PullDetailData>;
  /** A pull request's address and state (OPEN, MERGED or CLOSED), for one that isn't on the boards' lists. */
  pullSummary(n: number): Promise<{ url: string; state: string }>;
  /** The pull request's changes as `git diff` prints them. */
  pullDiff(n: number): Promise<string>;
  issueDetail(n: number): Promise<IssueDetailData>;
  /** Comments on an issue, or on a pull request's conversation. */
  comment(kind: 'issue' | 'pull', n: number, body: string, env: ForgeEnv): Promise<GhComment>;
  /** Posts a review that only comments, its text read from `file`. Resolves to its address. */
  review(n: number, file: string, env: ForgeEnv): Promise<string>;
  /** Merges, or with `auto` has the forge merge once what it requires passes. */
  merge(n: number, method: GhMergeMethod, deleteBranch: boolean, auto: boolean, env: ForgeEnv): Promise<void>;
  close(kind: 'issue' | 'pull', n: number, opts: CloseOptions, env: ForgeEnv): Promise<void>;
  /** Every label the repository has. */
  labels(): Promise<GhLabel[]>;
  /** Puts labels on an issue or pull request and takes others off; resolves to the ones it has now. */
  setLabels(kind: 'issue' | 'pull', n: number, add: string[], remove: string[], env: ForgeEnv): Promise<GhLabel[]>;
  /** Assigns the issue to whoever `env` is signed in as. */
  assignToMe(issue: number, env: ForgeEnv): Promise<void>;
}

export interface OpenPr {
  number: number;
  url: string;
}

export interface CreatePr {
  branch: string;
  /** The branch it merges into; unset, the repository's default. */
  base?: string;
  title: string;
  body: string;
  /** A checkout of the repository: the forge finds it from its remote. */
  cwd: string;
  env: ForgeEnv;
  /** How long it may take, in ms. */
  timeout?: number;
}

/** A command to run, for cloning a repository. */
export interface CloneCommand {
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

/** What the office does with a forge besides one repository's boards. */
export interface ForgeOps {
  readonly kind: ForgeKind;
  /** The open pull request from `branch`, if there is one. */
  findOpenPr(branch: string, cwd: string): Promise<OpenPr | undefined>;
  createPr(a: CreatePr): Promise<OpenPr>;
  prBody(url: string, cwd: string, env: ForgeEnv): Promise<string>;
  setPrBody(url: string, body: string, cwd: string, env: ForgeEnv): Promise<void>;
  /** Asks the forge about a repository: its name there, as the office names it, and whether it has no commits yet. */
  viewRepo(repo: string, cwd: string): Promise<{ repo: string; empty: boolean }>;
  /** The repositories the office's own sign-in can clone, most recently pushed first. */
  listRepos(cwd: string): Promise<RepoChoice[]>;
  /** `gh repo clone` or `glab repo clone`, with git's progress. */
  cloneCommand(repo: string, dest: string, progress: boolean): CloneCommand;
  /** Whether the CLI can be run, and who it's signed in as (on `host`, for a forge with more than one). */
  whoami(cwd: string, env?: ForgeEnv, host?: string): Promise<{ login?: string; signedOut?: boolean; missing?: boolean; error?: string }>;
}
