import type { ForgeKind } from '../shared/forge.js';
import type { GhIssue, GhIssueDetail, GhLabel, GhPull, GhPullDetail, GhRepoInfo, GhState, GhMergeMethod, GhCloseReason, GhComment } from '../shared/protocol.js';
import { forgeFor, type Forge } from './forge/index.js';
import type { GhAs } from './signins.js';

// The floor's issue and pull request boards. Where the project lives (GitHub, or GitLab with merge
// requests for pull requests) is the Forge's business (see forge/); this keeps what the boards
// remember: the latest lists, labels and claims made from the office, and the merges to ring for.

export { gh } from './forge/cli.js';

const REFRESH_MS = 90_000;
/** How long the repo's list of labels is kept before the label picker asks the forge again. */
const LABELS_MS = 60_000;

/**
 * Spots pull requests that merged between two looks at the list, so the gong rings however they
 * merged: from the PR window, by a worker's `gh pr merge`, by auto-merge, or on GitHub itself.
 */
export class MergeWatch {
  /** Open at the last look; unset until the first, so starting the office up rings for nothing. */
  private open?: Set<number>;
  /** Rang for already (merged from the PR window), so the next look doesn't ring them again. */
  private rang = new Set<number>();

  /** The gong rings for `n`: false if it already has. */
  ring(n: number): boolean {
    if (this.rang.has(n)) return false;
    this.rang.add(n);
    return true;
  }

  /** A fresh list from GitHub: the pull requests that merged since the last look and haven't rung yet. */
  look(pulls: GhPull[]): GhPull[] {
    const open = this.open;
    const merged = open ? pulls.filter((p) => p.state === 'MERGED' && open.has(p.number) && !this.rang.has(p.number)) : [];
    // Once GitHub says it merged, it never shows as open again to ring twice.
    for (const p of pulls) if (p.state === 'MERGED') this.rang.delete(p.number);
    this.open = new Set(pulls.filter((p) => p.state === 'OPEN').map((p) => p.number));
    return merged;
  }
}

/**
 * The issues workers just took. Assigning one on GitHub and listing the issues again takes seconds,
 * so each is marked `taken` on the board from the moment it's handed over until a list has its assignee.
 */
export class Claims {
  /** By issue number: when GitHub had it assigned (Infinity until it answers). */
  private claimed = new Map<number, { at: number }>();

  /** A worker took issue `n`. Call what it returns once GitHub has answered, with whether it's assigned now. */
  take(n: number): (assigned: boolean, now?: number) => void {
    const claim = { at: Infinity };
    this.claimed.set(n, claim);
    return (assigned, now = Date.now()) => {
      if (assigned) claim.at = now;
      // Unless someone handed it over again meanwhile, and GitHub hasn't answered them yet.
      else if (this.claimed.get(n) === claim) this.claimed.delete(n);
    };
  }

  has(n: number): boolean {
    return this.claimed.has(n);
  }

  /**
   * `items` with the taken ones marked. A list asked for (`asked`) before an issue was assigned doesn't
   * have its assignee yet, so it stays marked over it; one asked for after is believed, and the claim forgotten.
   */
  mark(items: GhIssue[], asked = 0): GhIssue[] {
    for (const [n, claim] of this.claimed) if (claim.at < asked) this.claimed.delete(n);
    return items.map(({ taken, ...it }) => (this.claimed.has(it.number) ? { ...it, taken: true } : it));
  }
}

export class GitHub {
  issues: GhState<GhIssue> = { items: [], fetchedAt: 0, loading: false };
  pulls: GhState<GhPull> = { items: [], fetchedAt: 0, loading: false };
  /** Where the project lives, and how the office talks to it. */
  readonly forge: Forge;
  private timer?: NodeJS.Timeout;
  private repo?: Promise<GhRepoInfo>;
  private login?: Promise<string>;
  private labelList?: { at: number; list: Promise<GhLabel[]> };
  /** Labels just changed from the office, by "issue:N" or "pull:N", and when. */
  private relabeled = new Map<string, { labels: GhLabel[]; at: number }>();
  private claims = new Claims();
  /** The look at the issues that's under way, if one is. */
  private listing?: Promise<void>;

  constructor(
    private dir: string,
    private onIssues: (s: GhState<GhIssue>) => void,
    private onPulls: (s: GhState<GhPull>) => void,
    /** The repository, as the office names it (see parseRepo); unset, its checkout's origin says. */
    repo?: string,
  ) {
    this.forge = forgeFor(dir, repo);
  }

  get kind(): ForgeKind {
    return this.forge.kind;
  }

  start() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  async refresh() {
    await Promise.all([this.refreshIssues(), this.refreshPulls()]);
  }

  /** The repository's full name and how it lets PRs merge. Asked once (again after a failure). */
  repoInfo(): Promise<GhRepoInfo> {
    this.repo ??= this.forge.repoInfo();
    this.repo.catch(() => (this.repo = undefined));
    return this.repo;
  }

  /** Who the office's own sign-in is, which is who it comments as for everyone without their own. Asked once; '' when the CLI can't say. */
  viewer(): Promise<string> {
    this.login ??= this.forge.viewer();
    this.login.catch(() => (this.login = undefined));
    return this.login.catch(() => '');
  }

  /**
   * A PR's description, conversation, line comments, checks and whether it can merge. `me` is the
   * login of whoever asked, when they're signed in to their own; else it's the office's.
   */
  async pullDetail(n: number, me?: string): Promise<GhPullDetail> {
    const [detail, repo, viewer] = await Promise.all([this.forge.pullDetail(n), this.repoInfo(), me ?? this.viewer()]);
    return { ...detail, repo, viewer };
  }

  /** The PR's unified diff, as `git diff` prints it. */
  pullDiff(n: number): Promise<string> {
    return this.forge.pullDiff(n);
  }

  async issueDetail(n: number, me?: string): Promise<GhIssueDetail> {
    const [detail, viewer] = await Promise.all([this.forge.issueDetail(n), me ?? this.viewer()]);
    return { ...detail, viewer };
  }

  /**
   * Comments on an issue, or on a PR's conversation, as `as` or else the office. Returns the comment
   * as it was saved, or why it couldn't.
   */
  async comment(kind: 'issue' | 'pull', n: number, body: string, as?: GhAs): Promise<{ comment?: GhComment; error?: string }> {
    let comment: GhComment;
    try {
      comment = await this.forge.comment(kind, n, body, as?.env);
    } catch (err) {
      return { error: (err as Error).message };
    }
    // The issue board counts comments; a PR's card shows when it was last updated.
    void (kind === 'issue' ? this.refreshIssues() : this.refreshPulls());
    return { comment };
  }

  /**
   * Posts a review on a pull request that only comments (the meeting room's review panel), its body
   * read from a file. Resolves to the review's URL.
   */
  async review(n: number, file: string, as?: GhAs): Promise<string> {
    const url = await this.forge.review(n, file, as?.env);
    void this.refreshPulls();
    return url;
  }

  /** Merges a PR, or with `auto` has the forge merge it once its requirements pass. Returns an error. */
  async merge(n: number, method: GhMergeMethod, deleteBranch: boolean, auto: boolean, as?: GhAs): Promise<string | undefined> {
    try {
      await this.forge.merge(n, method, deleteBranch, auto, as?.env);
    } catch (err) {
      return (err as Error).message;
    }
    void this.refreshPulls();
    return undefined;
  }

  /** Closes an issue, or a pull request without merging it, optionally saying why. Returns an error. */
  async close(kind: 'issue' | 'pull', n: number, opts: { comment?: string; reason?: GhCloseReason; deleteBranch?: boolean }, as?: GhAs): Promise<string | undefined> {
    try {
      await this.forge.close(kind, n, opts, as?.env);
    } catch (err) {
      return (err as Error).message;
    }
    const refresh = () => (kind === 'issue' ? this.refreshIssues() : this.refreshPulls());
    // A refresh already in flight was asked before it closed and can still list it as open, so look again shortly after.
    void refresh().then(() => {
      if ((kind === 'issue' ? this.issues : this.pulls).items.some((i) => i.number === n && i.state === 'OPEN')) setTimeout(() => void refresh(), 3000);
    });
    return undefined;
  }

  /** Every label the repository has, for the label picker. Asked again after a minute (or a failure). */
  repoLabels(): Promise<GhLabel[]> {
    if (!this.labelList || Date.now() - this.labelList.at > LABELS_MS) {
      const list = this.forge.labels();
      this.labelList = { at: Date.now(), list };
      list.catch(() => this.labelList?.list === list && (this.labelList = undefined));
    }
    return this.labelList.list;
  }

  /**
   * Puts labels on an issue or PR and takes others off, as `as` or else the office. Returns the
   * labels it has now, or why they didn't change.
   */
  async setLabels(kind: 'issue' | 'pull', n: number, add: string[], remove: string[], as?: GhAs): Promise<{ labels?: GhLabel[]; error?: string }> {
    let now: GhLabel[];
    try {
      now = await this.forge.setLabels(kind, n, add, remove, as?.env);
    } catch (err) {
      // Some may have changed before it failed.
      void (kind === 'issue' ? this.refreshIssues() : this.refreshPulls());
      return { error: (err as Error).message };
    }
    // The board shows them at once, before the next look at the forge (see relabel).
    const at = Date.now();
    this.relabeled.set(`${kind}:${n}`, { labels: now, at });
    if (kind === 'issue') {
      this.issues = { ...this.issues, items: this.relabel('issue', this.issues.items, at) };
      this.onIssues(this.issues);
      void this.refreshIssues();
    } else {
      this.pulls = { ...this.pulls, items: this.relabel('pull', this.pulls.items, at) };
      this.onPulls(this.pulls);
      void this.refreshPulls();
    }
    return { labels: now };
  }

  /**
   * A list asked for before a label change made here still has the old labels, so the new ones are
   * kept over it; a list asked for after the change is believed, and the change forgotten.
   */
  private relabel<T extends { number: number; labels: GhLabel[] }>(kind: 'issue' | 'pull', items: T[], asked: number): T[] {
    return items.map((it) => {
      const key = `${kind}:${it.number}`;
      const r = this.relabeled.get(key);
      if (!r) return it;
      if (r.at < asked) {
        this.relabeled.delete(key);
        return it;
      }
      return { ...it, labels: r.labels };
    });
  }

  /**
   * A worker took the issue: it moves to In progress on the board at once, and is assigned on the
   * forge to `as` (else the office's own sign-in), which is what keeps it there. Returns an error when
   * it wouldn't assign it, and the card goes back to where it was.
   */
  async claim(issue: number, as?: GhAs): Promise<string | undefined> {
    const answered = this.claims.take(issue);
    this.showClaims();
    try {
      await this.forge.assignToMe(issue, as?.env);
    } catch (err) {
      answered(false);
      this.showClaims();
      return (err as Error).message;
    }
    answered(true);
    // For its assignee's name. A look already under way was asked before it was assigned, so look again after it.
    void this.refreshIssues().then(() => (this.claims.has(issue) ? this.refreshIssues() : undefined));
    return undefined;
  }

  /** Puts the issues workers have taken (or no longer have) on the board, ahead of the next look at the forge. */
  private showClaims() {
    this.issues = { ...this.issues, items: this.claims.mark(this.issues.items) };
    this.onIssues(this.issues);
  }

  /** Asks for the issues. With a look already under way it's that one, which may have been asked before whatever just changed. */
  refreshIssues(): Promise<void> {
    this.listing ??= this.listIssues().finally(() => (this.listing = undefined));
    return this.listing;
  }

  private async listIssues() {
    this.issues = { ...this.issues, loading: true };
    this.onIssues(this.issues);
    const asked = Date.now();
    try {
      const items = this.claims.mark(this.relabel('issue', await this.forge.issues(), asked), asked);
      this.issues = { items, fetchedAt: Date.now(), loading: false };
    } catch (err) {
      this.issues = { ...this.issues, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.onIssues(this.issues);
  }

  async refreshPulls() {
    if (this.pulls.loading) return;
    this.pulls = { ...this.pulls, loading: true };
    this.onPulls(this.pulls);
    const asked = Date.now();
    try {
      const items = this.relabel('pull', await this.forge.pulls(), asked);
      this.pulls = { items, fetchedAt: Date.now(), loading: false };
    } catch (err) {
      this.pulls = { ...this.pulls, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.onPulls(this.pulls);
  }
}
