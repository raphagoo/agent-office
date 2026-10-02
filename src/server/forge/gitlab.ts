import { readFileSync } from 'node:fs';
import { normalizeRepo } from '../../shared/floors.js';
import { forgeOf, gitlabHosts, repoHost, repoPath } from '../../shared/forge.js';
import type { GhComment, GhIssue, GhLabel, GhMergeMethod, GhPull, GhRepoInfo, GhReviewComment, RepoChoice } from '../../shared/protocol.js';
import { glab } from './cli.js';
import { closesOf, jobCheck, labelsOf, mergeStatusOf, pipelineChecks, reviewOf, stateOf, unifiedDiff, type DiffFile } from './gitlab-map.js';
import { originRepo } from './origin.js';
import type { CloneCommand, CloseOptions, CreatePr, Forge, ForgeEnv, ForgeOps, IssueDetailData, OpenPr, PullDetailData } from './types.js';

// GitLab, through `glab api`: every call is the REST API, so what's asked of GitLab doesn't depend
// on which flags a version of glab has. Writes send JSON on stdin. A GitLab merge request is a
// pull request to the office, and its `iid` (the number in the project) is its number.

const PAGE = 100;
const MR_REBASE_WAIT_MS = 90_000;

export interface Call {
  /** A checkout (or any folder): glab runs there. */
  cwd: string;
  env?: ForgeEnv;
  body?: unknown;
  timeout?: number;
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** One REST call: the method, the path under /api/v4, and what to run it with. Resolves to its JSON (undefined for an empty answer). */
export type GitlabApi = <T = any>(host: string, method: Method, endpoint: string, c: Call) => Promise<T>;

/** The REST call, through `glab api`. */
async function call<T = any>(host: string, method: Method, endpoint: string, c: Call): Promise<T> {
  const args = ['api', '--hostname', host, endpoint];
  if (method !== 'GET') args.push('--method', method);
  if (c.body !== undefined) args.push('--input', '-', '-H', 'Content-Type: application/json');
  const out = await glab(args, { cwd: c.cwd, env: c.env, timeout: c.timeout, input: c.body !== undefined ? JSON.stringify(c.body) : undefined });
  return (out.trim() ? JSON.parse(out) : undefined) as T;
}

/** A list, a page at a time, up to `max` of it. */
async function list<T = any>(api: GitlabApi, host: string, endpoint: string, max: number, c: Call): Promise<T[]> {
  const items: T[] = [];
  const sep = endpoint.includes('?') ? '&' : '?';
  // The page size stays the same from one page to the next, or the pages would overlap.
  const perPage = Math.min(PAGE, max);
  for (let page = 1; items.length < max; page++) {
    const got = await api<T[]>(host, 'GET', `${endpoint}${sep}per_page=${perPage}&page=${page}`, c);
    if (!Array.isArray(got)) break;
    items.push(...got);
    if (got.length < perPage) break;
  }
  return items.slice(0, max);
}

/** Where a project's merge request is, for its address and which `iid` an address is for. */
const mrNumber = (url: string) => Number(/\/merge_requests\/(\d+)/.exec(url)?.[1]);

const noteOf = (host: string, path: string, kind: 'issues' | 'merge_requests', n: number, note: any): GhComment => ({
  id: String(note.id),
  author: note.author?.username ?? 'ghost',
  body: String(note.body ?? ''),
  createdAt: note.created_at ?? '',
  url: `https://${host}/${path}/-/${kind}/${n}#note_${note.id}`,
});

export class GitlabForge implements Forge {
  readonly kind = 'gitlab' as const;
  private host: string;
  private path: string;
  private project: string;

  /** `repo` is how the office names it: host/group/…/project. */
  constructor(
    repo: string,
    private dir: string,
    private api: GitlabApi = call,
  ) {
    this.host = repoHost(repo);
    this.path = repoPath(repo);
    this.project = `projects/${encodeURIComponent(this.path)}`;
  }

  private get<T = any>(endpoint: string, env?: ForgeEnv, timeout?: number): Promise<T> {
    return this.api<T>(this.host, 'GET', `${this.project}${endpoint}`, { cwd: this.dir, env, timeout });
  }

  private send<T = any>(method: 'POST' | 'PUT' | 'DELETE', endpoint: string, body: unknown, env: ForgeEnv, timeout?: number): Promise<T> {
    return this.api<T>(this.host, method, `${this.project}${endpoint}`, { cwd: this.dir, env, body: body ?? (method === 'DELETE' ? undefined : {}), timeout });
  }

  private all<T = any>(endpoint: string, max: number, env?: ForgeEnv): Promise<T[]> {
    return list<T>(this.api, this.host, `${this.project}${endpoint}`, max, { cwd: this.dir, env });
  }

  async repoInfo(): Promise<GhRepoInfo> {
    const p = await this.get(``);
    // A merge request is squashed unless the project says it never may be; rebasing first is always possible.
    const methods: GhMergeMethod[] = ['merge', 'rebase'];
    if (p.squash_option !== 'never') methods.unshift('squash');
    return { nameWithOwner: String(p.path_with_namespace ?? this.path), methods };
  }

  async viewer(): Promise<string> {
    return String((await this.api(this.host, 'GET', 'user', { cwd: this.dir })).username ?? '');
  }

  async issues(): Promise<GhIssue[]> {
    const q = 'order_by=updated_at&sort=desc&with_labels_details=true';
    // Open and closed separately, so old open issues are never crowded out by recent closed ones.
    const [open, closed] = await Promise.all([this.all(`/issues?state=opened&${q}`, 300), this.all(`/issues?state=closed&${q}`, 40)]);
    return [...open, ...closed].map((i) => ({
      number: i.iid,
      title: String(i.title ?? ''),
      state: stateOf(i.state),
      url: String(i.web_url ?? ''),
      author: i.author?.username ?? '',
      labels: labelsOf(i.labels),
      assignees: (i.assignees ?? []).map((a: any) => String(a.username)),
      createdAt: i.created_at ?? '',
      updatedAt: i.updated_at ?? '',
      body: String(i.description ?? '').slice(0, 4000),
      comments: Number(i.user_notes_count ?? 0),
    }));
  }

  async pulls(): Promise<GhPull[]> {
    const q = 'order_by=updated_at&sort=desc&with_labels_details=true';
    const [open, merged, closed, pipelines] = await Promise.all([
      this.all(`/merge_requests?state=opened&${q}`, 150),
      this.all(`/merge_requests?state=merged&${q}`, 30),
      this.all(`/merge_requests?state=closed&${q}`, 40),
      // Pipelines are matched to merge requests by the commit they ran for. A project with none (or with pipelines off) has no checks.
      this.get<any[]>('/pipelines?order_by=updated_at&sort=desc&per_page=100').catch(() => [] as any[]),
    ]);
    // The latest pipeline of each commit comes first.
    const status = new Map<string, unknown>();
    for (const p of Array.isArray(pipelines) ? pipelines : []) if (typeof p.sha === 'string' && !status.has(p.sha)) status.set(p.sha, p.status);
    return [...open, ...merged, ...closed].map((p) => ({
      number: p.iid,
      title: String(p.title ?? ''),
      state: stateOf(p.state),
      isDraft: p.draft === true || p.work_in_progress === true,
      url: String(p.web_url ?? ''),
      author: p.author?.username ?? '',
      labels: labelsOf(p.labels),
      reviewDecision: reviewOf(p.detailed_merge_status, 0),
      headRefName: String(p.source_branch ?? ''),
      headRefOid: typeof p.sha === 'string' ? p.sha : undefined,
      baseRefName: String(p.target_branch ?? ''),
      createdAt: p.created_at ?? '',
      updatedAt: p.updated_at ?? '',
      // GitLab's list says nothing of how big a merge request is.
      additions: 0,
      deletions: 0,
      checks: pipelineChecks(typeof p.sha === 'string' ? status.get(p.sha) : undefined),
      body: String(p.description ?? '').slice(0, 4000),
      closes: closesOf(p.description),
    }));
  }

  async pullDetail(n: number): Promise<PullDetailData> {
    const mr = `/merge_requests/${n}`;
    const [p, notes, discussions, commits, approvals] = await Promise.all([
      this.get(mr),
      this.all(`${mr}/notes?sort=asc&order_by=created_at`, 500),
      this.all(`${mr}/discussions`, 500),
      this.get<any[]>(`${mr}/commits?per_page=${PAGE}`),
      // Approvals are there on every plan, but a project can have them off.
      this.get(`${mr}/approvals`).catch(() => undefined),
    ]);
    const jobs: any[] = p.head_pipeline?.id ? await this.all(`/pipelines/${p.head_pipeline.id}/jobs`, 200).catch(() => []) : [];
    const approvedBy: any[] = approvals?.approved_by ?? [];
    const reviewComments: GhReviewComment[] = [];
    for (const d of discussions) {
      const diff = (d.notes ?? []).filter((x: any) => x.type === 'DiffNote' && !x.system);
      diff.forEach((x: any, i: number) => {
        const pos = x.position ?? {};
        const right = typeof pos.new_line === 'number';
        reviewComments.push({
          id: Number(x.id),
          replyTo: i > 0 ? Number(diff[0].id) : undefined,
          author: x.author?.username ?? 'ghost',
          body: String(x.body ?? ''),
          createdAt: x.created_at ?? '',
          url: `${p.web_url}#note_${x.id}`,
          path: String(pos.new_path ?? pos.old_path ?? ''),
          line: right ? pos.new_line : typeof pos.old_line === 'number' ? pos.old_line : null,
          side: right || typeof pos.old_line !== 'number' ? 'RIGHT' : 'LEFT',
        });
      });
    }
    const { mergeable, mergeStateStatus } = mergeStatusOf(p.detailed_merge_status, p.has_conflicts, p.draft);
    return {
      number: p.iid,
      body: String(p.description ?? ''),
      state: stateOf(p.state),
      isDraft: p.draft === true || p.work_in_progress === true,
      reviewDecision: reviewOf(p.detailed_merge_status, approvedBy.length),
      headRefName: String(p.source_branch ?? ''),
      baseRefName: String(p.target_branch ?? ''),
      mergeable,
      mergeStateStatus,
      commits: Array.isArray(commits) ? commits.length : 0,
      comments: notes.filter((x) => !x.system && x.type !== 'DiffNote').map((x) => noteOf(this.host, this.path, 'merge_requests', n, x)),
      reviews: approvedBy.map((a) => ({ id: `approval-${a.user?.id}`, author: a.user?.username ?? 'ghost', body: '', createdAt: p.updated_at ?? '', url: p.web_url, state: 'APPROVED' })),
      reviewComments,
      checks: jobs.map(jobCheck),
    };
  }

  async pullSummary(n: number): Promise<{ url: string; state: string }> {
    const p = await this.get(`/merge_requests/${n}`);
    return { url: String(p.web_url ?? ''), state: stateOf(p.state) };
  }

  async pullDiff(n: number): Promise<string> {
    // `diffs` came in GitLab 15.7; `changes` answers on the ones before it.
    try {
      const files = await this.all<DiffFile>(`/merge_requests/${n}/diffs`, 3000);
      return unifiedDiff(files);
    } catch (err) {
      if (!/404|not found/i.test((err as Error).message)) throw err;
      return unifiedDiff((await this.get(`/merge_requests/${n}/changes`, undefined, 60_000)).changes ?? []);
    }
  }

  async issueDetail(n: number): Promise<IssueDetailData> {
    const [i, notes] = await Promise.all([this.get(`/issues/${n}`), this.all(`/issues/${n}/notes?sort=asc&order_by=created_at`, 500)]);
    return { number: i.iid, state: stateOf(i.state), body: String(i.description ?? ''), comments: notes.filter((x) => !x.system).map((x) => noteOf(this.host, this.path, 'issues', n, x)) };
  }

  async comment(kind: 'issue' | 'pull', n: number, body: string, env: ForgeEnv): Promise<GhComment> {
    const where = kind === 'issue' ? 'issues' : 'merge_requests';
    return noteOf(this.host, this.path, where, n, await this.send('POST', `/${where}/${n}/notes`, { body }, env));
  }

  async review(n: number, file: string, env: ForgeEnv): Promise<string> {
    // GitLab's reviews are approvals and threads; a review that only comments is a note on the merge request.
    const note = noteOf(this.host, this.path, 'merge_requests', n, await this.send('POST', `/merge_requests/${n}/notes`, { body: readFileSync(file, 'utf8') }, env, 60_000));
    return note.url ?? '';
  }

  async merge(n: number, method: GhMergeMethod, deleteBranch: boolean, auto: boolean, env: ForgeEnv): Promise<void> {
    if (method === 'rebase') await this.rebase(n, env);
    const body: Record<string, unknown> = { squash: method === 'squash', should_remove_source_branch: deleteBranch };
    // Merge once the pipeline passes. (merge_when_pipeline_succeeds is the older name of auto_merge.)
    if (auto) Object.assign(body, { auto_merge: true, merge_when_pipeline_succeeds: true });
    await this.send('PUT', `/merge_requests/${n}/merge`, body, env, 90_000);
  }

  /** Rebases the source branch onto the target's (GitLab does it in the background) and waits for that to finish. */
  private async rebase(n: number, env: ForgeEnv) {
    await this.send('PUT', `/merge_requests/${n}/rebase`, {}, env);
    const until = Date.now() + MR_REBASE_WAIT_MS;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const p = await this.get(`/merge_requests/${n}?include_rebase_in_progress=true`, env);
      if (p.merge_error) throw new Error(String(p.merge_error));
      if (!p.rebase_in_progress) return;
      if (Date.now() > until) throw new Error('GitLab is still rebasing the branch — try the merge again in a moment');
    }
  }

  async close(kind: 'issue' | 'pull', n: number, opts: CloseOptions, env: ForgeEnv): Promise<void> {
    const where = kind === 'issue' ? 'issues' : 'merge_requests';
    // GitLab keeps no reason for closing an issue: it goes in a comment, as it would be said.
    const comment = opts.comment || (kind === 'issue' && opts.reason === 'not planned' ? 'Closing as not planned.' : '');
    const branch = kind === 'pull' && opts.deleteBranch ? await this.get(`/merge_requests/${n}`, env).then((p) => (p.source_project_id === p.target_project_id ? String(p.source_branch) : undefined)) : undefined;
    if (comment) await this.send('POST', `/${where}/${n}/notes`, { body: comment }, env);
    await this.send('PUT', `/${where}/${n}`, { state_event: 'close' }, env);
    if (branch) await this.send('DELETE', `/repository/branches/${encodeURIComponent(branch)}`, undefined, env).catch(() => undefined);
  }

  async labels(): Promise<GhLabel[]> {
    return (await this.all(`/labels`, 1000)).map((l) => labelsOf([l])[0]).filter(Boolean);
  }

  async setLabels(kind: 'issue' | 'pull', n: number, add: string[], remove: string[], env: ForgeEnv): Promise<GhLabel[]> {
    const where = kind === 'issue' ? 'issues' : 'merge_requests';
    const body: Record<string, string> = {};
    if (add.length) body.add_labels = add.join(',');
    if (remove.length) body.remove_labels = remove.join(',');
    const now = await this.send<{ labels?: unknown }>('PUT', `/${where}/${n}`, body, env);
    // The answer names the labels; the colors are the repository's.
    const known = new Map((await this.labels().catch(() => [] as GhLabel[])).map((l) => [l.name, l]));
    return labelsOf(now.labels).map((l) => ({ name: l.name, color: known.get(l.name)?.color ?? l.color }));
  }

  async assignToMe(issue: number, env: ForgeEnv): Promise<void> {
    const me = await this.api(this.host, 'GET', 'user', { cwd: this.dir, env });
    const had: number[] = ((await this.get(`/issues/${issue}`, env)).assignees ?? []).map((a: any) => Number(a.id));
    // assignee_ids replaces who's assigned; taking an issue adds to them.
    await this.send('PUT', `/issues/${issue}`, { assignee_ids: [...new Set([...had, Number(me.id)])] }, env);
  }
}

// ---------------------------------------------------------------------------

/** The repository a checkout is of: its origin, which is on the host the merge request is made on. */
function repoOf(cwd: string): { host: string; path: string; project: string } {
  const repo = originRepo(cwd);
  if (!repo || forgeOf(repo) !== 'gitlab') throw new Error('This project has no GitLab remote yet. Push it to GitLab (git remote add origin <url>) to fill the boards.');
  const path = repoPath(repo);
  return { host: repoHost(repo), path, project: `projects/${encodeURIComponent(path)}` };
}

export const gitlabOps: ForgeOps = gitlabOpsWith(call);

/** What the office does with GitLab besides one repository's boards, over `api` (the REST call; tests pass their own). */
export function gitlabOpsWith(api: GitlabApi): ForgeOps {
  return {
    kind: 'gitlab',

    async findOpenPr(branch: string, cwd: string): Promise<OpenPr | undefined> {
      const r = repoOf(cwd);
      const found = (await api<any[]>(r.host, 'GET', `${r.project}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}&per_page=1`, { cwd }))[0];
      return found ? { number: found.iid, url: found.web_url } : undefined;
    },

    async createPr(a: CreatePr): Promise<OpenPr> {
      const r = repoOf(a.cwd);
      const target = a.base ?? String((await api(r.host, 'GET', r.project, { cwd: a.cwd, env: a.env })).default_branch ?? 'main');
      const mr = await api(r.host, 'POST', `${r.project}/merge_requests`, { cwd: a.cwd, env: a.env, timeout: a.timeout ?? 60_000, body: { source_branch: a.branch, target_branch: target, title: a.title, description: a.body } });
      if (!mr?.iid || !mr.web_url) throw new Error('GitLab did not return a merge request');
      return { number: mr.iid, url: mr.web_url };
    },

    async prBody(url, cwd, env) {
      const r = repoOf(cwd);
      return String((await api(r.host, 'GET', `${r.project}/merge_requests/${mrNumber(url)}`, { cwd, env })).description ?? '');
    },

    async setPrBody(url, body, cwd, env) {
      const r = repoOf(cwd);
      await api(r.host, 'PUT', `${r.project}/merge_requests/${mrNumber(url)}`, { cwd, env, timeout: 60_000, body: { description: body } });
    },

    async viewRepo(repo: string, cwd: string) {
      const p = await api(repoHost(repo), 'GET', `projects/${encodeURIComponent(repoPath(repo))}`, { cwd, timeout: 30_000 });
      return { repo: normalizeRepo(`${repoHost(repo)}/${p.path_with_namespace}`) ?? repo, empty: p.empty_repo === true };
    },

    async listRepos(cwd: string): Promise<RepoChoice[]> {
      // Every GitLab the office knows of; one that can't be asked (not signed in) only matters when none can.
      const hosts = gitlabHosts();
      const results = await Promise.allSettled(hosts.map((host) => list<any>(api, host, 'projects?membership=true&archived=false&order_by=last_activity_at&sort=desc&statistics=false', 1000, { cwd }).then((ps) => ({ host, ps }))));
      const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      if (!ok.length) throw (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason;
      const repos: RepoChoice[] = [];
      for (const { host, ps } of ok) {
        for (const p of ps) {
          const name = normalizeRepo(`${host}/${p.path_with_namespace}`);
          if (!name) continue;
          repos.push({ name, description: typeof p.description === 'string' && p.description ? p.description.slice(0, 200) : undefined, private: p.visibility !== 'public', pushedAt: typeof p.last_activity_at === 'string' ? p.last_activity_at : undefined });
        }
      }
      return repos;
    },

    cloneCommand(repo: string, dest: string, progress: boolean): CloneCommand {
      // glab takes group/…/project, and finds the host by GITLAB_HOST.
      return { cmd: 'glab', args: ['repo', 'clone', repoPath(repo), dest, ...(progress ? ['--', '--progress'] : [])], env: { GITLAB_HOST: repoHost(repo) } };
    },

    async whoami(cwd: string, env?: ForgeEnv, host = gitlabHosts()[0]) {
      try {
        return { login: String((await api(host, 'GET', 'user', { cwd, env })).username ?? '') };
      } catch (err) {
        const why = (err as Error).message;
        if (/not installed/i.test(why)) return { missing: true, error: why };
        return { signedOut: /isn't signed in|sign-in stopped working|401|unauthorized/i.test(why), error: why };
      }
    },
  };
}
