import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SignIns } from '../src/server/signins.js';
import { gitConfigText } from '../src/server/signins-git.js';

// Everyone's own GitHub and GitLab (see signins.ts): whose credentials end up in whose environment.

const ID = 'abc123def456';

function office(t: { after(fn: () => void): void }, opts: { admin?: boolean; bins?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-signins-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = { PATH: '/usr/bin', HOME: dir, GH_TOKEN: 'office-gh', GITHUB_TOKEN: 'office-gh2', GITLAB_TOKEN: 'office-gl', OAUTH_TOKEN: 'office-oauth', GLAB_CONFIG_DIR: '/office/glab', GH_CONFIG_DIR: '/office/gh', GIT_CONFIG_GLOBAL: '/office/gitconfig' };
  const s = new SignIns(dir, null, opts.bins ? path.join(dir, 'no-such-gh') : null, opts.bins ? path.join(dir, 'no-such-glab') : null, () => ({ ...base }), () => !!opts.admin, () => {});
  /** What the last looks found, as signins.json keeps it. */
  const seen = (who: Record<string, string>) => {
    mkdirSync(path.join(dir, 'homes', ID), { recursive: true });
    writeFileSync(path.join(dir, 'homes', ID, 'signins.json'), JSON.stringify({ seen: who }));
  };
  return { dir, s, base, seen, home: path.join(dir, 'homes', ID) };
}

test("an account's own sign-ins replace the office's, each in its own folder", (t) => {
  const { s, base, home } = office(t);
  const env = s.apply(ID, { ...base }, []);
  assert.equal(env.GH_CONFIG_DIR, path.join(home, 'gh'));
  assert.equal(env.GLAB_CONFIG_DIR, path.join(home, 'glab'));
  assert.equal(env.GIT_CONFIG_GLOBAL, path.join(home, 'gitconfig'));
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'OAUTH_TOKEN']) assert.equal(env[k], undefined, `${k} of the office doesn't reach them`);
  assert.equal(existsSync(path.join(home, 'glab')), true);
});

test('asked for one forge, only that one is put in', (t) => {
  const { s, base, home } = office(t);
  const gitlab = s.apply(ID, { ...base }, [], 'gitlab');
  assert.equal(gitlab.GLAB_CONFIG_DIR, path.join(home, 'glab'));
  assert.equal(gitlab.GITLAB_TOKEN, undefined);
  assert.equal(gitlab.GH_CONFIG_DIR, '/office/gh', 'GitHub is left as it was');
  assert.equal(gitlab.GH_TOKEN, 'office-gh');
  const github = s.apply(ID, { ...base }, [], 'github');
  assert.equal(github.GH_CONFIG_DIR, path.join(home, 'gh'));
  assert.equal(github.GITLAB_TOKEN, 'office-gl');
  assert.equal(github.GLAB_CONFIG_DIR, '/office/glab');
});

test('the office acts as someone only once they have signed in to the forge, and says which one when they have not', (t) => {
  const { s, seen, home } = office(t);
  assert.match(String(s.ghAs(ID, 'gitlab')), /Sign in to GitLab first/);
  assert.match(String(s.ghAs(ID, 'github')), /Sign in to GitHub first/);
  assert.equal(s.forgeReady(ID, 'gitlab'), false);
  seen({ gitlab: '@bob' });
  assert.equal(s.forgeReady(ID, 'gitlab'), true);
  assert.equal(s.forgeReady(ID, 'github'), false, 'one forge being ready says nothing of the other');
  assert.match(String(s.ghAs(ID, 'github')), /Sign in to GitHub first/);
  const as = s.ghAs(ID, 'gitlab');
  assert.equal(typeof as, 'object');
  const env = (as as { env: Record<string, string> }).env;
  // A worker across repositories may have a pull request on each: both of their logins are in.
  assert.equal(env.GLAB_CONFIG_DIR, path.join(home, 'glab'));
  assert.equal(env.GH_CONFIG_DIR, path.join(home, 'gh'));
  assert.equal(env.GITLAB_TOKEN, undefined);
  assert.equal(s.login(ID, 'gitlab'), 'bob');
  assert.equal(s.login(ID, 'github'), undefined);
});

test("an admin who uses the office's own GitLab keeps the office's environment for it", (t) => {
  const { s, base } = office(t, { admin: true });
  assert.equal(s.useOffice(ID, 'gitlab'), undefined);
  assert.equal(s.ghAs(ID, 'gitlab'), undefined, 'as the office itself');
  assert.equal(s.forgeReady(ID, 'gitlab'), true);
  const env = s.apply(ID, { ...base }, [], 'gitlab');
  assert.equal(env.GLAB_CONFIG_DIR, '/office/glab');
  assert.equal(env.GITLAB_TOKEN, 'office-gl');
  assert.equal(office(t).s.useOffice(ID, 'gitlab'), "Only admins can use the office's own sign-ins");
});

test('the sign-ins of an account say how each is signed in', (t) => {
  const { s, seen } = office(t);
  seen({ github: '@ann' });
  const state = s.state(ID);
  assert.deepEqual([state.github.status, state.github.who, state.github.how], ['ok', '@ann', 'login']);
  assert.deepEqual([state.gitlab.status, state.gitlab.how], ['none', 'login']);
  assert.deepEqual([state.claude.status], ['none']);
});

test('a token is checked before anything runs, and one for a CLI that is not installed says so', async (t) => {
  const { s } = office(t);
  assert.match(String(await s.token(ID, 'gitlab', 'glpat-xxxxxxxxxxxxxxxxxxxx')), /GitLab CLI \(glab\) isn't installed/);
  assert.match(String(await s.token(ID, 'github', 'ghp_xxxxxxxxxxxxxxxxxxxxxxxx')), /GitHub CLI \(gh\) isn't installed/);
  const installed = office(t, { bins: true });
  assert.match(String(await installed.s.token(ID, 'gitlab', 'not a token!')), /doesn't look like a GitLab token \(glpat-…\)/);
  assert.match(String(await installed.s.token(ID, 'github', 'glpat-with-dash-xxxxxxxxxxxx')), /doesn't look like a GitHub token/);
  assert.match(String(installed.s.start(ID, 'gitlab') ?? ''), /^$|./, 'starting a sign-in answers');
});

test('the account git config has each forge as the credentials for its host, and the right identity per remote', () => {
  const base = { includes: ['/etc/gitconfig'], gitlabHosts: ['gitlab.com', 'git.example.com'], gitlabFile: '/h/gitconfig-gitlab' };
  const both = gitConfigText({ ...base, bins: { github: '/usr/bin/gh', gitlab: '/usr/bin/glab' }, users: { github: { name: 'Ann', email: '1+ann@users.noreply.github.com' }, gitlab: { name: 'Ann G', email: '2-ann@users.noreply.gitlab.com' } } });
  assert.match(both.main, /\[credential "https:\/\/github.com"\]/);
  assert.match(both.main, /\[credential "https:\/\/gist.github.com"\]/);
  assert.match(both.main, /\[credential "https:\/\/gitlab.com"\]/);
  assert.match(both.main, /\[credential "https:\/\/git.example.com"\]/);
  assert.match(both.main, /helper = "!'\/usr\/bin\/glab' auth git-credential"/);
  assert.match(both.main, /\[user\]\n\tname = "Ann"\n\temail = "1\+ann@users.noreply.github.com"/, 'GitHub is the default identity');
  for (const url of ['https://gitlab.com/**', 'git@gitlab.com:**', 'https://git.example.com/**']) assert.ok(both.main.includes(`[includeIf "hasconfig:remote.*.url:${url}"]`), url);
  assert.match(both.main, /path = "\/h\/gitconfig-gitlab"/);
  assert.match(both.gitlab ?? '', /name = "Ann G"\n\temail = "2-ann@users.noreply.gitlab.com"/);
  // Only GitLab: its identity is the default, and there's no second file.
  const lab = gitConfigText({ ...base, bins: { gitlab: '/usr/bin/glab' }, users: { gitlab: { name: 'Bo', email: '3-bo@users.noreply.gitlab.com' } } });
  assert.match(lab.main, /\[user\]\n\tname = "Bo"/);
  assert.doesNotMatch(lab.main, /includeIf|github\.com/);
  assert.equal(lab.gitlab, undefined);
  // A CLI that isn't installed has no credentials line, and a name can't break out of the file.
  const none = gitConfigText({ ...base, bins: {}, users: { github: { name: 'Mal"\n[core]\nx=1', email: 'm@x' } } });
  assert.doesNotMatch(none.main, /credential/);
  assert.ok(!none.main.includes('\n[core]'));
  assert.match(readFileSync(new URL('../src/server/signins-git.ts', import.meta.url), 'utf8'), /quote/);
});

