import type { GhCheck, GhComment, GhIssue, GhLabel, GhMergeMethod, GhPull, GhRepoInfo, RepoChoice } from '../../shared/protocol.js';
import { normalizeRepo } from '../../shared/floors.js';
import { truncate } from '../workers/util.js';
import { gh } from './cli.js';
import type { CloneCommand, CloseOptions, CreatePr, Forge, ForgeEnv, ForgeOps, IssueDetailData, OpenPr, PullDetailData } from './types.js';

// GitHub, through `gh`: what the issue and pull request boards and windows show, and what's done to them.

export function labels(raw: any[] | undefined): GhLabel[] {
  return (raw ?? []).map((l) => ({ name: String(l.name), color: `#${l.color ?? '888888'}` }));
}

export function checksOf(rollup: any[] | undefined): GhPull['checks'] {
  if (!rollup?.length) return 'none';
  let pending = false;
  for (const c of rollup) {
    const concl = String(c.conclusion ?? c.state ?? '').toUpperCase();
    const status = String(c.status ?? '').toUpperCase();
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(concl)) return 'fail';
    if (status && status !== 'COMPLETED') pending = true;
    if (concl === 'PENDING' || concl === 'EXPECTED') pending = true;
  }
  return pending ? 'pending' : 'pass';
}

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];

/** One entry of statusCheckRollup: a CheckRun (Actions) or a StatusContext (other CI). */
function checkOf(c: any): GhCheck {
  const concl = String(c.conclusion ?? c.state ?? '').toUpperCase();
  const status = String(c.status ?? '').toUpperCase();
  let state: GhCheck['state'] = 'pass';
  if (FAILED.includes(concl)) state = 'fail';
  else if ((status && status !== 'COMPLETED') || !concl || concl === 'PENDING' || concl === 'EXPECTED') state = 'pending';
  else if (['SKIPPED', 'NEUTRAL', 'STALE'].includes(concl)) state = 'skip';
  const name = String(c.name ?? c.context ?? 'check');
  return { name: c.workflowName ? `${c.workflowName} / ${name}` : name, state, url: c.detailsUrl ?? c.targetUrl ?? undefined };
}

function commentsOf(raw: any[] | undefined): GhComment[] {
  return (raw ?? []).map((c) => ({
    id: String(c.id),
    author: c.author?.login ?? 'ghost',
    body: String(c.body ?? ''),
    createdAt: c.createdAt ?? c.submittedAt ?? '',
    url: c.url,
    state: c.state,
  }));
}

export class GithubForge implements Forge {
  readonly kind = 'github' as const;

  constructor(private dir: string) {}

  async repoInfo(): Promise<GhRepoInfo> {
    const out = await gh(['repo', 'view', '--json', 'nameWithOwner,squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed'], this.dir);
    const r = JSON.parse(out);
    const methods = (['squash', 'merge', 'rebase'] as const).filter((m) => r[{ squash: 'squashMergeAllowed', merge: 'mergeCommitAllowed', rebase: 'rebaseMergeAllowed' }[m]]);
    return { nameWithOwner: String(r.nameWithOwner), methods: methods.length ? [...methods] : ['squash', 'merge', 'rebase'] };
  }

  async viewer(): Promise<string> {
    return (await gh(['api', 'user', '--jq', '.login'], this.dir)).trim();
  }

  async issues(): Promise<GhIssue[]> {
    // Open and closed separately, so old open issues are never crowded out by recent closed ones.
    const fields = 'number,title,state,url,author,labels,assignees,createdAt,updatedAt,body,comments';
    const [open, closed] = await Promise.all([
      gh(['issue', 'list', '--state', 'open', '--limit', '300', '--json', fields], this.dir),
      gh(['issue', 'list', '--state', 'closed', '--limit', '40', '--json', fields], this.dir),
    ]);
    return [...JSON.parse(open), ...JSON.parse(closed)].map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      url: i.url,
      author: i.author?.login ?? '',
      labels: labels(i.labels),
      assignees: (i.assignees ?? []).map((a: any) => a.login),
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      body: String(i.body ?? '').slice(0, 4000),
      comments: Array.isArray(i.comments) ? i.comments.length : Number(i.comments ?? 0),
    }));
  }

  async pulls(): Promise<GhPull[]> {
    const fields = 'number,title,state,isDraft,url,author,labels,reviewDecision,headRefName,headRefOid,baseRefName,createdAt,updatedAt,additions,deletions,statusCheckRollup,body,closingIssuesReferences';
    const [open, merged, closed] = await Promise.all([
      gh(['pr', 'list', '--state', 'open', '--limit', '150', '--json', fields], this.dir),
      gh(['pr', 'list', '--state', 'merged', '--limit', '30', '--json', fields], this.dir),
      gh(['pr', 'list', '--state', 'closed', '--limit', '40', '--json', fields], this.dir),
    ]);
    // `--state closed` includes merged PRs; keep only the ones closed without merging.
    const seen = new Set<number>();
    const all = [...JSON.parse(open), ...JSON.parse(merged), ...JSON.parse(closed)].filter((p) => !seen.has(p.number) && seen.add(p.number));
    return all.map((p) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      isDraft: !!p.isDraft,
      url: p.url,
      author: p.author?.login ?? '',
      labels: labels(p.labels),
      reviewDecision: p.reviewDecision ?? '',
      headRefName: p.headRefName,
      headRefOid: typeof p.headRefOid === 'string' ? p.headRefOid : undefined,
      baseRefName: p.baseRefName,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      additions: p.additions ?? 0,
      deletions: p.deletions ?? 0,
      checks: checksOf(p.statusCheckRollup),
      body: String(p.body ?? '').slice(0, 4000),
      closes: (p.closingIssuesReferences ?? []).map((r: any) => Number(r.number)).filter((n: number) => Number.isInteger(n) && n > 0),
    }));
  }

  async pullDetail(n: number): Promise<PullDetailData> {
    const fields = 'number,body,state,isDraft,reviewDecision,headRefName,baseRefName,mergeable,mergeStateStatus,commits,comments,reviews,statusCheckRollup';
    const jq = '.[] | {id, in_reply_to_id, path, line, side, body, user: .user.login, created_at, html_url}';
    const [view, lines] = await Promise.all([gh(['pr', 'view', String(n), '--json', fields], this.dir), gh(['api', `repos/{owner}/{repo}/pulls/${n}/comments?per_page=100`, '--paginate', '--jq', jq], this.dir)]);
    const p = JSON.parse(view);
    const reviewComments = lines
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .map((c) => ({
        id: c.id,
        replyTo: c.in_reply_to_id ?? undefined,
        author: c.user ?? 'ghost',
        body: String(c.body ?? ''),
        createdAt: c.created_at,
        url: c.html_url,
        path: c.path,
        line: c.line ?? null,
        side: (c.side === 'LEFT' ? 'LEFT' : 'RIGHT') as 'LEFT' | 'RIGHT',
      }));
    return {
      number: p.number,
      body: String(p.body ?? ''),
      state: p.state,
      isDraft: !!p.isDraft,
      reviewDecision: p.reviewDecision ?? '',
      headRefName: p.headRefName,
      baseRefName: p.baseRefName,
      mergeable: p.mergeable ?? 'UNKNOWN',
      mergeStateStatus: p.mergeStateStatus ?? 'UNKNOWN',
      commits: (p.commits ?? []).length,
      comments: commentsOf(p.comments),
      // A line comment also makes an empty COMMENTED review; the comment itself is shown instead.
      reviews: commentsOf(p.reviews).filter((r) => r.body.trim() || r.state !== 'COMMENTED'),
      reviewComments,
      checks: (p.statusCheckRollup ?? []).map(checkOf),
    };
  }

  async pullSummary(n: number): Promise<{ url: string; state: string }> {
    return JSON.parse(await gh(['pr', 'view', String(n), '--json', 'url,state'], this.dir));
  }

  pullDiff(n: number): Promise<string> {
    return gh(['pr', 'diff', String(n), '--color', 'never'], this.dir, 60_000);
  }

  async issueDetail(n: number): Promise<IssueDetailData> {
    const i = JSON.parse(await gh(['issue', 'view', String(n), '--json', 'number,state,body,comments'], this.dir));
    return { number: i.number, state: i.state, body: String(i.body ?? ''), comments: commentsOf(i.comments) };
  }

  async comment(_kind: 'issue' | 'pull', n: number, body: string, env: ForgeEnv): Promise<GhComment> {
    // -f sends the body as a plain string: no @file reading, no {owner} filling in. To GitHub a PR is an issue too.
    const jq = '{id: .node_id, author: {login: .user.login}, body, createdAt: .created_at, url: .html_url}';
    const out = await gh(['api', '--method', 'POST', `repos/{owner}/{repo}/issues/${n}/comments`, '-f', `body=${body}`, '--jq', jq], this.dir, undefined, env);
    return commentsOf([JSON.parse(out)])[0];
  }

  async review(n: number, file: string, env: ForgeEnv): Promise<string> {
    // -F reads @file's contents as the value; {owner}/{repo} are filled in from the checkout's remote.
    return (await gh(['api', '--method', 'POST', `repos/{owner}/{repo}/pulls/${n}/reviews`, '-F', `body=@${file}`, '-f', 'event=COMMENT', '--jq', '.html_url'], this.dir, 60_000, env)).trim();
  }

  async merge(n: number, method: GhMergeMethod, deleteBranch: boolean, auto: boolean, env: ForgeEnv): Promise<void> {
    const repo = await this.repoInfo();
    // --repo keeps gh out of the office's own checkout: without it, --delete-branch also deletes
    // the local branch and switches the project folder over to the base branch.
    const args = ['pr', 'merge', String(n), `--${method}`, '--repo', repo.nameWithOwner];
    if (deleteBranch) args.push('--delete-branch');
    if (auto) args.push('--auto');
    await gh(args, this.dir, 90_000, env);
  }

  async close(kind: 'issue' | 'pull', n: number, opts: CloseOptions, env: ForgeEnv): Promise<void> {
    const repo = await this.repoInfo();
    // --repo for the same reason as merge: --delete-branch must leave the office's checkout alone.
    const args = [kind === 'issue' ? 'issue' : 'pr', 'close', String(n), '--repo', repo.nameWithOwner];
    // --flag=value, so a comment starting with "-" isn't read as a flag.
    if (opts.comment) args.push(`--comment=${opts.comment}`);
    if (kind === 'issue' && opts.reason) args.push(`--reason=${opts.reason}`);
    if (kind === 'pull' && opts.deleteBranch) args.push('--delete-branch');
    await gh(args, this.dir, undefined, env);
  }

  async labels(): Promise<GhLabel[]> {
    const out = await gh(['api', 'repos/{owner}/{repo}/labels?per_page=100', '--paginate', '--jq', '.[] | {name, color, description}'], this.dir);
    return out
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .map((l) => ({ name: String(l.name), color: `#${l.color ?? '888888'}`, description: l.description || undefined }));
  }

  async setLabels(_kind: 'issue' | 'pull', n: number, add: string[], remove: string[], env: ForgeEnv): Promise<GhLabel[]> {
    const path = `repos/{owner}/{repo}/issues/${n}/labels`;
    const jq = '[.[] | {name, color}]';
    let now: GhLabel[] | undefined;
    // -f labels[]=… sends a JSON array of plain strings: no @file reading, no {owner} filling in.
    if (add.length) now = labels(JSON.parse(await gh(['api', '--method', 'POST', path, ...add.flatMap((l) => ['-f', `labels[]=${l}`]), '--jq', jq], this.dir, undefined, env)));
    for (const l of remove) {
      try {
        now = labels(JSON.parse(await gh(['api', '--method', 'DELETE', `${path}/${encodeURIComponent(l)}`, '--jq', jq], this.dir, undefined, env)));
      } catch (err) {
        // Someone took it off already, which is what was asked for.
        if (!/label does not exist/i.test((err as Error).message)) throw err;
      }
    }
    return now ?? labels(JSON.parse(await gh(['api', `${path}?per_page=100`, '--jq', jq], this.dir)));
  }

  async assignToMe(issue: number, env: ForgeEnv): Promise<void> {
    await gh(['issue', 'edit', String(issue), '--add-assignee', '@me'], this.dir, undefined, env);
  }
}

// ---------------------------------------------------------------------------

export const githubOps: ForgeOps = {
  kind: 'github',

  async findOpenPr(branch: string, cwd: string): Promise<OpenPr | undefined> {
    const out = await gh(['pr', 'list', '--head', branch, '--state', 'open', '--limit', '1', '--json', 'number,url'], cwd);
    const found = JSON.parse(out || '[]')[0];
    return found ? { number: found.number, url: found.url } : undefined;
  },

  /** `gh pr create` for a pushed branch; resolves to the new pull request. */
  async createPr(a: CreatePr): Promise<OpenPr> {
    const out = await gh(['pr', 'create', '--head', a.branch, ...(a.base ? ['--base', a.base] : []), '--title', a.title, '--body', a.body], a.cwd, a.timeout ?? 60_000, a.env);
    const url = out.trim().split('\n').pop() ?? '';
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
    if (!number) throw new Error(`gh did not return a pull request URL (${truncate(out, 120)})`);
    return { number, url };
  },

  prBody: (url, cwd, env) => gh(['pr', 'view', url, '--json', 'body', '--jq', '.body'], cwd, 30_000, env),

  async setPrBody(url, body, cwd, env) {
    await gh(['pr', 'edit', url, '--body', body], cwd, 60_000, env);
  },

  async viewRepo(repo: string, cwd: string) {
    const view = JSON.parse(await gh(['repo', 'view', repo, '--json', 'nameWithOwner,isEmpty'], cwd, 30_000)) as { nameWithOwner?: string; isEmpty?: boolean };
    return { repo: normalizeRepo(view.nameWithOwner) ?? repo, empty: view.isEmpty === true };
  },

  async listRepos(cwd: string): Promise<RepoChoice[]> {
    const out = await gh(
      ['api', '--paginate', 'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member', '--jq', '.[] | {name: .full_name, description: (.description // ""), private: .private, pushedAt: .pushed_at}'],
      cwd,
      90_000,
    );
    const repos: RepoChoice[] = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { name?: unknown; description?: unknown; private?: unknown; pushedAt?: unknown };
        const name = normalizeRepo(r.name);
        if (!name) continue;
        repos.push({
          name,
          description: typeof r.description === 'string' && r.description ? r.description.slice(0, 200) : undefined,
          private: r.private === true,
          pushedAt: typeof r.pushedAt === 'string' ? r.pushedAt : undefined,
        });
      } catch {
        // not a line of ours
      }
    }
    return repos;
  },

  cloneCommand(repo: string, dest: string, progress: boolean): CloneCommand {
    return { cmd: 'gh', args: ['repo', 'clone', repo, dest, ...(progress ? ['--', '--progress'] : [])], env: {} };
  },

  async whoami(cwd: string, env?: ForgeEnv) {
    try {
      return { login: (await gh(['api', 'user', '--jq', '.login'], cwd, 30_000, env)).trim() };
    } catch (err) {
      const why = (err as Error).message;
      if (/not installed/i.test(why)) return { missing: true, error: why };
      return { signedOut: /auth login|not logged in|authentication|bad credentials|HTTP 401|stopped working/i.test(why), error: why };
    }
  },
};
