import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitlabForge, gitlabOpsWith, type GitlabApi } from '../src/server/forge/gitlab.js';
import { closesOf, jobCheck, labelsOf, mergeStatusOf, pipelineChecks, reviewOf, stateOf, unifiedDiff } from '../src/server/forge/gitlab-map.js';
import { forgeFor, opsOf } from '../src/server/forge/index.js';

// GitLab's boards and windows, driven through a fake of its REST API that answers the way GitLab
// does (and remembers what it was sent), so no glab, network or account is needed.

const P = 'projects/acme%2Fapi';

interface Sent {
  method: string;
  path: string;
  body?: any;
  env?: Record<string, string>;
}

function gitlab(extra: Record<string, (url: URL, body: any, method: string) => unknown> = {}) {
  const sent: Sent[] = [];
  const label = (name: string, color: string) => ({ name, color, description: `${name} things` });
  const issue = (iid: number, state: string, extraFields: object = {}) => ({
    iid,
    title: `Issue ${iid}`,
    state,
    web_url: `https://gitlab.com/acme/api/-/issues/${iid}`,
    author: { username: 'ann' },
    labels: [label('bug', '#d9534f')],
    assignees: [{ id: 7, username: 'bob' }],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    description: 'It broke',
    user_notes_count: 3,
    ...extraFields,
  });
  const mr = (iid: number, state: string, extraFields: object = {}) => ({
    iid,
    title: `MR ${iid}`,
    state,
    draft: false,
    web_url: `https://gitlab.com/acme/api/-/merge_requests/${iid}`,
    author: { username: 'ann' },
    labels: [label('feature', '#428bca')],
    source_branch: `feat-${iid}`,
    target_branch: 'main',
    sha: `sha${iid}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    description: 'Closes #1, and fixes #3. Mentions #9.',
    detailed_merge_status: 'mergeable',
    has_conflicts: false,
    ...extraFields,
  });
  const routes: Record<string, (url: URL, body: any, method: string) => unknown> = {
    [`GET ${P}`]: () => ({ path_with_namespace: 'acme/api', squash_option: 'default_on', default_branch: 'trunk', empty_repo: false }),
    'GET user': () => ({ id: 7, username: 'bob' }),
    [`GET ${P}/issues`]: (url) => (url.searchParams.get('state') === 'closed' ? [issue(2, 'closed')] : [issue(1, 'opened')]),
    [`GET ${P}/merge_requests`]: (url) => {
      const state = url.searchParams.get('state');
      if (state === 'merged') return [mr(4, 'merged')];
      if (state === 'closed') return [mr(3, 'closed')];
      if (url.searchParams.get('source_branch')) return url.searchParams.get('source_branch') === 'feat-5' ? [mr(5, 'opened')] : [];
      return [mr(5, 'opened', { draft: true, detailed_merge_status: 'not_approved' })];
    },
    [`GET ${P}/pipelines`]: () => [
      { sha: 'sha5', status: 'running' },
      { sha: 'sha5', status: 'failed' },
      { sha: 'sha4', status: 'success' },
      { sha: 'sha3', status: 'failed' },
    ],
    [`GET ${P}/merge_requests/5`]: () => mr(5, 'opened', { description: 'The body', detailed_merge_status: 'ci_must_pass', head_pipeline: { id: 99 } }),
    [`GET ${P}/merge_requests/5/notes`]: () => [
      { id: 1, author: { username: 'ann' }, body: 'Looks fine', created_at: 't1', system: false },
      { id: 2, author: { username: 'bot' }, body: 'added 1 commit', created_at: 't2', system: true },
      { id: 3, author: { username: 'bob' }, body: 'on a line', created_at: 't3', system: false, type: 'DiffNote' },
    ],
    [`GET ${P}/merge_requests/5/discussions`]: () => [
      {
        notes: [
          { id: 3, author: { username: 'bob' }, body: 'on a line', created_at: 't3', type: 'DiffNote', system: false, position: { new_path: 'src/a.ts', old_path: 'src/a.ts', new_line: 12, old_line: null } },
          { id: 8, author: { username: 'ann' }, body: 'fixed', created_at: 't4', type: 'DiffNote', system: false, position: { new_path: 'src/a.ts', old_path: 'src/a.ts', new_line: 12, old_line: null } },
        ],
      },
      { notes: [{ id: 9, author: { username: 'bob' }, body: 'gone', created_at: 't5', type: 'DiffNote', system: false, position: { new_path: 'old.ts', old_path: 'old.ts', new_line: null, old_line: 4 } }] },
      { notes: [{ id: 1, author: { username: 'ann' }, body: 'Looks fine', type: null, system: false }] },
    ],
    [`GET ${P}/merge_requests/5/commits`]: () => [{ id: 'a' }, { id: 'b' }],
    [`GET ${P}/merge_requests/5/approvals`]: () => ({ approved_by: [{ user: { id: 4, username: 'cara' } }] }),
    [`GET ${P}/pipelines/99/jobs`]: () => [
      { name: 'lint', stage: 'test', status: 'success', web_url: 'https://gitlab.com/j/1' },
      { name: 'unit', stage: 'test', status: 'failed', web_url: 'https://gitlab.com/j/2' },
      { name: 'flaky', stage: 'test', status: 'failed', allow_failure: true },
      { name: 'deploy', stage: 'deploy', status: 'manual' },
      { name: 'build', stage: 'build', status: 'running' },
    ],
    [`GET ${P}/merge_requests/5/diffs`]: () => [
      { old_path: 'a.txt', new_path: 'a.txt', diff: '@@ -1 +1 @@\n-one\n+two\n' },
      { old_path: 'new.txt', new_path: 'new.txt', new_file: true, b_mode: '100644', diff: '@@ -0,0 +1 @@\n+hi\n' },
      { old_path: 'gone.txt', new_path: 'gone.txt', deleted_file: true, a_mode: '100644', diff: '@@ -1 +0,0 @@\n-bye\n' },
      { old_path: 'was.txt', new_path: 'is.txt', renamed_file: true, diff: '' },
      { old_path: 'img.png', new_path: 'img.png', a_mode: '100644', b_mode: '100644', diff: '' },
    ],
    [`GET ${P}/issues/1`]: () => issue(1, 'opened', { assignees: [{ id: 2, username: 'zed' }] }),
    [`GET ${P}/issues/1/notes`]: () => [{ id: 11, author: { username: 'ann' }, body: 'me too', created_at: 'n1', system: false }],
    [`GET ${P}/labels`]: () => [label('bug', '#d9534f'), label('feature', '#428bca')],
    ...extra,
  };
  const api: GitlabApi = async (host, method, endpoint, c) => {
    const url = new URL(`https://x/${endpoint}`);
    const key = `${method} ${url.pathname.slice(1)}`;
    sent.push({ method, path: endpoint, body: c.body, env: c.env });
    assert.equal(host, 'gitlab.com');
    const route = routes[key] ?? (method !== 'GET' ? () => ({ id: 100, iid: 6, web_url: 'https://gitlab.com/acme/api/-/merge_requests/6', author: { username: 'bob' }, body: c.body?.body, created_at: 'now', labels: ['bug'] }) : undefined);
    if (!route) throw new Error(`404 not routed: ${key}`);
    return route(url, c.body, method) as never;
  };
  return { api, sent, forge: new GitlabForge('gitlab.com/acme/api', '/tmp', api), ops: gitlabOpsWith(api) };
}

test('the issue board lists open and recently closed issues in the shapes the boards show', async () => {
  const { forge } = gitlab();
  const issues = await forge.issues();
  assert.deepEqual(issues.map((i) => [i.number, i.state]), [[1, 'OPEN'], [2, 'CLOSED']]);
  const [first] = issues;
  assert.deepEqual(first.labels, [{ name: 'bug', color: '#d9534f', description: 'bug things' }]);
  assert.deepEqual([first.author, first.assignees, first.comments, first.url], ['ann', ['bob'], 3, 'https://gitlab.com/acme/api/-/issues/1']);
});

test('the pull request board lists merge requests, with the pipeline of the commit each is at, and what they close', async () => {
  const { forge } = gitlab();
  const pulls = await forge.pulls();
  assert.deepEqual(pulls.map((p) => [p.number, p.state, p.checks]), [[5, 'OPEN', 'pending'], [4, 'MERGED', 'pass'], [3, 'CLOSED', 'fail']]);
  const [open] = pulls;
  assert.equal(open.isDraft, true);
  assert.equal(open.reviewDecision, 'REVIEW_REQUIRED');
  assert.deepEqual([open.headRefName, open.headRefOid, open.baseRefName], ['feat-5', 'sha5', 'main']);
  assert.deepEqual(open.closes, [1, 3]);
});

test('a merge request in full: conversation, line comments, approvals, checks and whether it can merge', async () => {
  const { forge } = gitlab();
  const d = await forge.pullDetail(5);
  assert.deepEqual([d.number, d.body, d.state, d.commits], [5, 'The body', 'OPEN', 2]);
  assert.deepEqual(d.comments.map((c) => [c.id, c.author, c.body]), [['1', 'ann', 'Looks fine']], 'no system notes, no line comments');
  assert.equal(d.comments[0].url, 'https://gitlab.com/acme/api/-/merge_requests/5#note_1');
  assert.deepEqual(d.reviewComments.map((c) => [c.id, c.replyTo, c.path, c.line, c.side]), [
    [3, undefined, 'src/a.ts', 12, 'RIGHT'],
    [8, 3, 'src/a.ts', 12, 'RIGHT'],
    [9, undefined, 'old.ts', 4, 'LEFT'],
  ]);
  assert.deepEqual(d.reviews.map((r) => [r.author, r.state]), [['cara', 'APPROVED']]);
  assert.equal(d.reviewDecision, 'APPROVED');
  assert.deepEqual([d.mergeable, d.mergeStateStatus], ['MERGEABLE', 'BLOCKED']);
  assert.deepEqual(d.checks.map((c) => [c.name, c.state]), [['test / lint', 'pass'], ['test / unit', 'fail'], ['test / flaky', 'skip'], ['deploy / deploy', 'skip'], ['build / build', 'pending']]);
});

test("the diff window gets git's diff format, built from GitLab's files", async () => {
  const { forge } = gitlab();
  const diff = await forge.pullDiff(5);
  assert.equal(
    diff,
    [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-one',
      '+two',
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+hi',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/was.txt b/is.txt',
      'similarity index 100%',
      'rename from was.txt',
      'rename to is.txt',
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
      '',
    ].join('\n'),
  );
  assert.equal(unifiedDiff([]), '');
});

test('an issue in full, and comments, as whoever the call is made as', async () => {
  const { forge, sent } = gitlab();
  const i = await forge.issueDetail(1);
  assert.deepEqual([i.number, i.state, i.body, i.comments.map((c) => c.body)], [1, 'OPEN', 'It broke', ['me too']]);
  const env = { GLAB_CONFIG_DIR: '/homes/abc/glab' };
  const note = await forge.comment('pull', 5, '@file.txt -x', env);
  assert.deepEqual([note.author, note.body, note.url], ['bob', '@file.txt -x', 'https://gitlab.com/acme/api/-/merge_requests/5#note_100']);
  const post = sent.find((s) => s.method === 'POST')!;
  assert.deepEqual([post.path, post.body, post.env], [`${P}/merge_requests/5/notes`, { body: '@file.txt -x' }, env]);
  await forge.comment('issue', 1, 'hello', undefined);
  assert.equal(sent.filter((s) => s.method === 'POST').at(-1)!.path, `${P}/issues/1/notes`);
});

test('merging squashes, deletes the branch and waits for the pipeline when asked, and rebases first on request', async () => {
  const { forge, sent } = gitlab({ [`PUT ${P}/merge_requests/5/rebase`]: () => ({ rebase_in_progress: true }), [`GET ${P}/merge_requests/5`]: () => ({ iid: 5, rebase_in_progress: false }) });
  await forge.merge(5, 'squash', true, true, undefined);
  const put = sent.find((s) => s.method === 'PUT')!;
  assert.equal(put.path, `${P}/merge_requests/5/merge`);
  assert.deepEqual(put.body, { squash: true, should_remove_source_branch: true, auto_merge: true, merge_when_pipeline_succeeds: true });
  sent.length = 0;
  await forge.merge(5, 'merge', false, false, undefined);
  assert.deepEqual(sent.map((s) => s.body), [{ squash: false, should_remove_source_branch: false }]);
  sent.length = 0;
  await forge.merge(5, 'rebase', false, false, undefined);
  assert.deepEqual(sent.map((s) => `${s.method} ${s.path.replace(P, '')}`), ['PUT /merge_requests/5/rebase', 'GET /merge_requests/5?include_rebase_in_progress=true', 'PUT /merge_requests/5/merge']);
});

test('a merge GitLab refuses says why', async () => {
  const { forge } = gitlab({
    [`PUT ${P}/merge_requests/5/merge`]: () => {
      throw new Error('405 Method Not Allowed');
    },
  });
  await assert.rejects(forge.merge(5, 'merge', false, false, undefined), /405 Method Not Allowed/);
});

test('closing comments first, says why an issue is closed in a comment, and can delete the branch', async () => {
  const { forge, sent } = gitlab({ [`GET ${P}/merge_requests/5`]: () => ({ iid: 5, source_branch: 'feat/5', source_project_id: 1, target_project_id: 1 }) });
  await forge.close('issue', 1, { reason: 'not planned' }, undefined);
  assert.deepEqual(sent.map((s) => [s.method, s.path.replace(P, ''), s.body]), [['POST', '/issues/1/notes', { body: 'Closing as not planned.' }], ['PUT', '/issues/1', { state_event: 'close' }]]);
  sent.length = 0;
  await forge.close('pull', 5, { comment: 'Superseded', deleteBranch: true }, undefined);
  assert.deepEqual(sent.map((s) => `${s.method} ${s.path.replace(P, '')}`), ['GET /merge_requests/5', 'POST /merge_requests/5/notes', 'PUT /merge_requests/5', 'DELETE /repository/branches/feat%2F5']);
  assert.deepEqual(sent[2].body, { state_event: 'close' });
});

test("a fork's merge request doesn't get its source branch deleted from this project", async () => {
  const { forge, sent } = gitlab({ [`GET ${P}/merge_requests/5`]: () => ({ iid: 5, source_branch: 'main', source_project_id: 2, target_project_id: 1 }) });
  await forge.close('pull', 5, { deleteBranch: true }, undefined);
  assert.equal(sent.some((s) => s.method === 'DELETE'), false);
});

test('labels: the repository has them with colors, and a change answers with the colors of the labels it left', async () => {
  const { forge, sent } = gitlab({ [`PUT ${P}/issues/1`]: () => ({ labels: ['bug', 'feature', 'unknown'] }) });
  assert.deepEqual(await forge.labels(), [
    { name: 'bug', color: '#d9534f', description: 'bug things' },
    { name: 'feature', color: '#428bca', description: 'feature things' },
  ]);
  const now = await forge.setLabels('issue', 1, ['feature', 'unknown'], ['wontfix'], undefined);
  assert.deepEqual(sent.find((s) => s.method === 'PUT')!.body, { add_labels: 'feature,unknown', remove_labels: 'wontfix' });
  assert.deepEqual(now.map((l) => [l.name, l.color]), [['bug', '#d9534f'], ['feature', '#428bca'], ['unknown', '#888888']]);
});

test('taking an issue adds the signed-in user to its assignees', async () => {
  const { forge, sent } = gitlab();
  await forge.assignToMe(1, { GLAB_CONFIG_DIR: '/h' });
  assert.deepEqual(sent.find((s) => s.method === 'PUT')!.body, { assignee_ids: [2, 7] });
  assert.equal(await forge.viewer(), 'bob');
});

test("the merge dialog's methods follow the project's squash setting", async () => {
  assert.deepEqual((await gitlab().forge.repoInfo()).methods, ['squash', 'merge', 'rebase']);
  const never = gitlab({ [`GET ${P}`]: () => ({ path_with_namespace: 'acme/api', squash_option: 'never' }) });
  assert.deepEqual((await never.forge.repoInfo()).methods, ['merge', 'rebase']);
  assert.equal((await never.forge.repoInfo()).nameWithOwner, 'acme/api');
});

test('a list is read a page at a time at a fixed page size, up to its limit', async () => {
  const pages: string[] = [];
  const many = Array.from({ length: 250 }, (_, i) => ({ iid: i + 1, state: 'opened', title: 't', author: {}, labels: [], assignees: [] }));
  const { forge } = gitlab({
    [`GET ${P}/issues`]: (url) => {
      if (url.searchParams.get('state') === 'closed') return [];
      pages.push(`${url.searchParams.get('page')}/${url.searchParams.get('per_page')}`);
      const page = Number(url.searchParams.get('page'));
      return many.slice((page - 1) * 100, page * 100);
    },
  });
  assert.equal((await forge.issues()).length, 250);
  assert.deepEqual(pages, ['1/100', '2/100', '3/100']);
});

test('the pipeline list being off (or unreadable) only means there are no checks', async () => {
  const { forge } = gitlab({
    [`GET ${P}/pipelines`]: () => {
      throw new Error('403 Forbidden');
    },
  });
  assert.deepEqual((await forge.pulls()).map((p) => p.checks), ['none', 'none', 'none']);
});

test('the pure mappings: states, labels, closing words, pipelines, merge status', () => {
  assert.deepEqual(['opened', 'locked', 'merged', 'closed', undefined].map(stateOf), ['OPEN', 'OPEN', 'MERGED', 'CLOSED', 'OPEN']);
  assert.deepEqual(labelsOf(['a', { name: 'b', color: 'ff0000' }, { name: 'c', color: 'nope' }, 5, null]), [
    { name: 'a', color: '#888888' },
    { name: 'b', color: '#ff0000' },
    { name: 'c', color: '#888888' },
  ]);
  assert.deepEqual(closesOf('Closes #1\nfixed: #2, Resolves issue #3, implements #4, closing #5, related to #6, Fixes group/proj#7'), [1, 2, 3, 4, 5]);
  assert.deepEqual(['success', 'failed', 'canceled', 'skipped', 'manual', 'running', 'created', '', undefined].map(pipelineChecks), ['pass', 'fail', 'fail', 'none', 'none', 'pending', 'pending', 'none', 'none']);
  assert.deepEqual(
    [
      mergeStatusOf('mergeable', false, false),
      mergeStatusOf('conflict', true, false),
      mergeStatusOf('checking', false, false),
      mergeStatusOf('draft_status', false, true),
      mergeStatusOf('need_rebase', false, false),
      mergeStatusOf('discussions_not_resolved', false, false),
      mergeStatusOf(undefined, false, false),
    ].map((m) => `${m.mergeable}/${m.mergeStateStatus}`),
    ['MERGEABLE/CLEAN', 'CONFLICTING/DIRTY', 'UNKNOWN/UNKNOWN', 'MERGEABLE/DRAFT', 'MERGEABLE/BEHIND', 'MERGEABLE/BLOCKED', 'UNKNOWN/UNKNOWN'],
  );
  assert.equal(reviewOf('not_approved', 0), 'REVIEW_REQUIRED');
  assert.equal(reviewOf('not_approved', 1), 'APPROVED');
  assert.equal(reviewOf('mergeable', 0), '');
  assert.equal(jobCheck({ name: 'x', status: 'canceled' }).state, 'fail');
});

/** A checkout whose origin is a GitLab project. */
function checkout(t: { after(fn: () => void): void }, origin: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-gitlab-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
  return dir;
}

test('a merge request is opened from a checkout of the project, against the default branch unless told another', async (t) => {
  const dir = checkout(t, 'git@gitlab.com:acme/api.git');
  const { ops, sent } = gitlab({ [`POST ${P}/merge_requests`]: () => ({ iid: 12, web_url: 'https://gitlab.com/acme/api/-/merge_requests/12' }) });
  const mr = await ops.createPr({ branch: 'feat-x', title: 'T', body: 'B', cwd: dir, env: { GLAB_CONFIG_DIR: '/h' } });
  assert.deepEqual(mr, { number: 12, url: 'https://gitlab.com/acme/api/-/merge_requests/12' });
  assert.deepEqual(sent.at(-1)!.body, { source_branch: 'feat-x', target_branch: 'trunk', title: 'T', description: 'B' });
  await ops.createPr({ branch: 'feat-x', base: 'release', title: 'T', body: 'B', cwd: dir, env: undefined });
  assert.equal(sent.at(-1)!.body.target_branch, 'release');
  assert.deepEqual(await ops.findOpenPr('feat-5', dir), { number: 5, url: 'https://gitlab.com/acme/api/-/merge_requests/5' });
  assert.equal(await ops.findOpenPr('nothing', dir), undefined);
  // The related-pull-requests block reads and rewrites the description.
  assert.equal(await ops.prBody('https://gitlab.com/acme/api/-/merge_requests/5', dir, undefined), 'The body');
  await ops.setPrBody('https://gitlab.com/acme/api/-/merge_requests/5', 'new', dir, undefined);
  assert.deepEqual(sent.at(-1)!.body, { description: 'new' });
});

test("a checkout that isn't on GitLab can't have a merge request opened from it", async (t) => {
  const dir = checkout(t, 'https://github.com/acme/api.git');
  await assert.rejects(gitlab().ops.findOpenPr('x', dir), /no GitLab remote/);
});

test('repositories are looked up and listed with their real names, and cloned with glab by their path on their host', async () => {
  const { ops } = gitlab({
    'GET projects/acme%2FAPI': () => ({ path_with_namespace: 'Acme/api', empty_repo: true }),
    'GET projects': () => [
      { path_with_namespace: 'acme/api', description: 'The API', visibility: 'private', last_activity_at: '2026-02-01T00:00:00Z' },
      { path_with_namespace: 'acme/tools/cli', description: null, visibility: 'public', last_activity_at: '2026-03-01T00:00:00Z' },
    ],
  });
  assert.deepEqual(await ops.viewRepo('gitlab.com/acme/API', '/tmp'), { repo: 'gitlab.com/Acme/api', empty: true });
  assert.deepEqual(await ops.listRepos('/tmp'), [
    { name: 'gitlab.com/acme/api', description: 'The API', private: true, pushedAt: '2026-02-01T00:00:00Z' },
    { name: 'gitlab.com/acme/tools/cli', description: undefined, private: false, pushedAt: '2026-03-01T00:00:00Z' },
  ]);
  const c = ops.cloneCommand('gitlab.com/acme/tools/cli', '/p/cli', true);
  assert.deepEqual([c.cmd, c.args, c.env], ['glab', ['repo', 'clone', 'acme/tools/cli', '/p/cli', '--', '--progress'], { GITLAB_HOST: 'gitlab.com' }]);
  assert.deepEqual(opsOf('github').cloneCommand('acme/api', '/p/api', false), { cmd: 'gh', args: ['repo', 'clone', 'acme/api', '/p/api'], env: {} });
});

test('the forge of a floor follows its repository, or its checkout when it has none recorded', (t) => {
  assert.equal(forgeFor('/tmp', 'gitlab.com/acme/api').kind, 'gitlab');
  assert.equal(forgeFor('/tmp', 'acme/api').kind, 'github');
  assert.equal(forgeFor(checkout(t, 'https://gitlab.com/acme/api.git')).kind, 'gitlab');
  assert.equal(forgeFor(checkout(t, 'https://github.com/acme/api.git')).kind, 'github');
  const bare = mkdtempSync(path.join(tmpdir(), 'agent-office-bare-'));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  mkdirSync(path.join(bare, 'x'));
  writeFileSync(path.join(bare, 'x', 'f'), '');
  assert.equal(forgeFor(path.join(bare, 'x')).kind, 'github', 'no origin: GitHub, which says it has no remote when asked');
});

// ---- cloning ----------------------------------------------------------------------------------

import { CloneRun, parseProgress, whyCloneFailed } from '../src/server/clone.js';

/** A stand-in for `glab repo clone`, run with node so it runs anywhere: says what git says, and what environment it got. */
const FAKE_CLONE = String.raw`
const fail = process.env.FAKE_FAIL;
process.stderr.write("Cloning into '" + process.argv[3] + "'...\n");
process.stderr.write('env GITLAB_HOST=' + process.env.GITLAB_HOST + ' NO_PROMPT=' + process.env.NO_PROMPT + ' GIT_TERMINAL_PROMPT=' + process.env.GIT_TERMINAL_PROMPT + '\n');
if (fail) { process.stderr.write(fail + '\n'); process.exit(128); }
process.stderr.write('remote: Compressing objects:  50% (1/2)\r');
setTimeout(() => process.exit(0), 700);
`;

test('a GitLab clone is watched the way a GitHub one is, in GitLab\'s words, with no prompts and its host in the environment', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-glab-clone-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'fake-clone.cjs');
  writeFileSync(script, FAKE_CLONE);
  const steps: string[] = [];
  const dest = path.join(dir, 'gitlab.com', 'acme', 'api');
  mkdirSync(path.dirname(dest), { recursive: true });
  const cmd = { cmd: process.execPath, args: [script, 'acme/api', dest], env: { GITLAB_HOST: 'gitlab.com' } };
  const run = await CloneRun.start(cmd, dest, path.join(dir, 'clone.log'), { forge: 'gitlab', tickMs: 30, changed: () => void 0 });
  assert.equal(typeof run, 'object', String(run));
  const r = run as CloneRun;
  const watch = setInterval(() => r.progress && steps.push(r.progress.step), 20);
  const end = await r.done;
  clearInterval(watch);
  assert.equal(end.code, 0);
  assert.match(end.output, /env GITLAB_HOST=gitlab.com NO_PROMPT=1 GIT_TERMINAL_PROMPT=0/);
  assert.ok(steps.includes('GitLab is packing it up'), `saw ${[...new Set(steps)].join(', ')}`);
});

test('a GitLab clone that cannot start says which CLI is missing', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-glab-clone-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = await CloneRun.start({ cmd: path.join(dir, 'no-such-glab'), args: [], env: {} }, path.join(dir, 'x', 'y'), path.join(dir, 'c.log'), { forge: 'gitlab' });
  assert.match(String(r), /GitLab CLI \(glab\) isn't installed/);
});

test('progress and failures are worded for the forge they came from', () => {
  assert.deepEqual(parseProgress('remote: Compressing objects:  50% (1/2)\r', 'gitlab'), { step: 'GitLab is packing it up', percent: 50 });
  assert.deepEqual(parseProgress("Cloning into '/x'...\n", 'gitlab'), { step: 'Connecting to GitLab' });
  assert.deepEqual(parseProgress("Cloning into '/x'...\n"), { step: 'Connecting to GitHub' });
  assert.match(whyCloneFailed('Host key verification failed.\n', 'gitlab'), /ssh -T git@gitlab\.com.*glab config set git_protocol https/);
  assert.match(whyCloneFailed('Host key verification failed.\n', 'gitlab', 'git.example.com'), /git@git\.example\.com/);
  assert.match(whyCloneFailed('git@gitlab.com: Permission denied (publickey).\n', 'gitlab'), /Preferences → SSH Keys/);
  assert.match(whyCloneFailed("fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled\n", 'gitlab'), /glab auth login/);
  assert.match(whyCloneFailed("fatal: could not read Username for 'https://github.com': terminal prompts disabled\n"), /gh auth setup-git/);
  assert.equal(whyCloneFailed('', 'gitlab'), 'glab failed');
});
