import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forgeOf, parseRepo, repoFolders, repoHost, repoPath, setGitlabHosts } from '../src/shared/forge.js';
import { normalizeRepo, sameRepo } from '../src/shared/floors.js';

test('a GitHub repository is still owner/name, however it is typed', () => {
  for (const v of ['acme/api', 'github.com/acme/api', 'https://github.com/acme/api.git', 'git@github.com:acme/api.git', 'ssh://git@github.com/acme/api', 'https://github.com/acme/api/issues/12?x=1', ' acme/api/ ']) {
    assert.equal(normalizeRepo(v), 'acme/api', v);
  }
  assert.equal(forgeOf('acme/api'), 'github');
  assert.equal(repoHost('acme/api'), 'github.com');
});

test('a GitLab repository is named host/group/…/project, with nested groups', () => {
  for (const v of [
    'gitlab.com/purjus/api',
    'https://gitlab.com/purjus/api.git',
    'git@gitlab.com:purjus/api.git',
    'ssh://git@gitlab.com:22/purjus/api.git',
    'https://oauth2:glpat-secret@gitlab.com/purjus/api.git',
    'https://gitlab.com/purjus/api/-/merge_requests/3',
    'https://gitlab.com/purjus/api/-/issues/12#note_1',
    'https://GitLab.com/purjus/api/',
  ]) {
    assert.equal(normalizeRepo(v), 'gitlab.com/purjus/api', v);
  }
  assert.equal(normalizeRepo('https://gitlab.com/purjus/clients/rrg/api.git'), 'gitlab.com/purjus/clients/rrg/api');
  const ref = parseRepo('gitlab.com/purjus/clients/rrg/api')!;
  assert.deepEqual([ref.kind, ref.host, ref.path], ['gitlab', 'gitlab.com', 'purjus/clients/rrg/api']);
  assert.equal(forgeOf('gitlab.com/purjus/api'), 'gitlab');
  assert.equal(repoHost('gitlab.com/purjus/api'), 'gitlab.com');
  assert.equal(repoPath('gitlab.com/purjus/clients/api'), 'purjus/clients/api');
  assert.deepEqual(repoFolders('gitlab.com/purjus/api'), ['gitlab.com', 'purjus', 'api']);
  assert.deepEqual(repoFolders('acme/api'), ['acme', 'api']);
});

test('the older page addresses of a GitLab project are cut off at the project', () => {
  assert.equal(normalizeRepo('https://gitlab.com/purjus/api/merge_requests/3'), 'gitlab.com/purjus/api');
  assert.equal(normalizeRepo('https://gitlab.com/purjus/api/tree/main/src'), 'gitlab.com/purjus/api');
});

test('what is not a repository on a forge the office knows is refused', () => {
  for (const v of [
    undefined,
    42,
    '',
    'api',
    'gitlab.com/api',
    'bitbucket.org/acme/api',
    'https://example.com/acme/api',
    'gitlab.com/../etc',
    'gitlab.com/purjus/..',
    'gitlab.com/purjus/--upload-pack=x',
    '--upload-pack=touch/x',
    'my.org/repo',
    `acme/${'a'.repeat(400)}`,
  ]) {
    assert.equal(normalizeRepo(v), undefined, String(v));
  }
});

test('a self-managed GitLab counts once the office is told of it, or when it is named gitlab.*', () => {
  assert.equal(normalizeRepo('git.purjus.fr/group/api'), undefined);
  assert.equal(normalizeRepo('https://gitlab.purjus.fr/group/api.git'), 'gitlab.purjus.fr/group/api');
  setGitlabHosts(['git.purjus.fr', 'not a host', 'localhost']);
  try {
    assert.equal(normalizeRepo('git@git.purjus.fr:group/sub/api.git'), 'git.purjus.fr/group/sub/api');
    assert.equal(forgeOf('git.purjus.fr/group/api'), 'gitlab');
    assert.equal(repoHost('git.purjus.fr/group/api'), 'git.purjus.fr');
  } finally {
    setGitlabHosts([]);
  }
});

test('repositories are compared without regard to case', () => {
  assert.equal(sameRepo('gitlab.com/Purjus/API', 'gitlab.com/purjus/api'), true);
  assert.equal(sameRepo('purjus/api', 'gitlab.com/purjus/api'), false);
});

import { forgeText } from '../src/shared/forge-text.js';
import { fillPrompt, PROMPTS, PROMPT_IDS } from '../src/shared/prompts.js';

test('a prompt written for GitHub says the same on GitLab, in glab commands and GitLab words', () => {
  const gh = 'Review pull request #{{number}}: "{{title}}". Use `gh pr view {{number}} --comments` and `gh pr diff {{number}}`. Wait with `gh pr checks {{number}} --watch`. Get onto its branch: `gh pr checkout {{number}}`. Read `gh issue view 3 --comments` on GitHub. See `gh api repos/{{repo}}/pulls/{{number}}/comments`. Open a PR; the PRs of the gh CLI.';
  assert.equal(forgeText(gh, 'github'), gh);
  assert.equal(forgeText(gh, undefined), gh);
  assert.equal(
    forgeText(gh, 'gitlab'),
    'Review merge request #{{number}}: "{{title}}". Use `glab mr view {{number}} --comments` and `glab mr diff {{number}}`. Wait with `glab ci status --live`. Get onto its branch: `glab mr checkout {{number}}`. Read `glab issue view 3 --comments` on GitLab. See `glab api projects/{{project}}/merge_requests/{{number}}/discussions`. Open a MR; the MRs of the glab CLI.',
  );
});

test("filling a GitLab prompt translates its template, never what's filled into it", () => {
  const text = 'Work on GitHub issue #{{number}}: "{{title}}". Read it with `gh issue view {{number}} --comments`, then open a pull request.';
  assert.equal(fillPrompt(text, { number: 3, title: 'Fix gh pr view for GitHub' }, 'gitlab'), 'Work on GitLab issue #3: "Fix gh pr view for GitHub". Read it with `glab issue view 3 --comments`, then open a merge request.');
  assert.equal(fillPrompt(text, { number: 3, title: 'T' }), 'Work on GitHub issue #3: "T". Read it with `gh issue view 3 --comments`, then open a pull request.');
});

test('no default prompt is left talking about gh or GitHub on a GitLab project', () => {
  for (const id of PROMPT_IDS) {
    const said = forgeText(PROMPTS[id].text, 'gitlab');
    assert.doesNotMatch(said, /\bgh\b|GitHub|pull request|\bPRs?\b/, `${id}: ${said.match(/.{0,30}(\bgh\b|GitHub|pull request|\bPRs?\b).{0,30}/)?.[0]}`);
  }
});
