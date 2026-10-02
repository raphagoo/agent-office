# GitLab

Back to the [README](../README.md).

The office works with projects on GitLab as it does with ones on GitHub, and with both at once: each floor uses the forge its project's `origin` is on. The issues board, the PR board (merge requests, on GitLab), the PR window, comments, labels, merging, closing, opening a pull request for a worker, cloning from the elevator and per-person sign-ins all follow it.

## What you need

- **`glab`**, the [GitLab CLI](https://gitlab.com/gitlab-org/cli), on the machine the office runs on, signed in with `glab auth login`. GitHub's `gh` is only needed for GitHub projects, and the other way round.
- A GitLab account that can see the projects. For a project on gitlab.com that's all. For a self-managed GitLab, see [Self-managed GitLab](#self-managed-gitlab).

`agent-office setup` (and the first-start walkthrough) asks about GitLab after GitHub, and offers `glab auth login` if you want it. Skipping it only means GitLab projects aren't listed.

## Adding a GitLab project

Open the elevator and pick it from the list, which shows your GitHub and GitLab projects together, most recently active first. Or type its address:

```
gitlab.com/group/project
https://gitlab.com/group/subgroup/project.git
git@gitlab.com:group/project.git
```

A GitHub project is still `owner/name`, as it always was. A GitLab project is named with its host in front, `gitlab.com/group/project`, because a GitLab project can sit in subgroups. It is cloned into `<projects folder>/gitlab.com/group/project`, so it can never land on top of a GitHub owner's folder.

From a terminal: `agent-office setup --project gitlab.com/group/project`.

## What maps to what

| In the office | On GitLab |
| --- | --- |
| Issues board | Project issues (open, and the latest closed) |
| PR board and PR window | Merge requests. The number is the MR's `iid` (the `!12` in the project) |
| Checks | The pipeline that ran for the MR's latest commit; the window lists that pipeline's jobs. A job that failed but is allowed to fail shows as skipped |
| Review decision | Approvals (`approved_by`), or *review required* while GitLab says `not_approved` |
| Can it merge? | GitLab's `detailed_merge_status`: conflicts, a pipeline that must pass, unresolved discussions, a rebase needed, and a draft all show as they do on GitHub |
| Merge, squash, rebase | `PUT …/merge` with `squash`; *rebase* rebases the branch first and waits for GitLab to finish. The squash choice goes away when the project never allows it |
| Merge automatically once checks pass | GitLab's auto-merge (merge when pipeline succeeds) |
| Close as *not planned* | GitLab keeps no reason for closing an issue: the office says it in a comment |
| Labels | Project labels (and its groups'), with their colors |
| Line comments | Discussions on the diff |
| *Fixes #12* in a description | The words GitLab itself closes issues on (*closes*, *fixes*, *resolves*, *implements*) |
| Opening a PR for a worker | `POST …/merge_requests` from its pushed branch, against the project's default branch unless the worker was cut from another |

The office reaches GitLab through `glab api`, the REST API, rather than through each of `glab`'s subcommands, so it doesn't depend on which flags your `glab` has. Workers are told to use `glab` (`glab mr view`, `glab mr diff`, `glab issue view`…) on a GitLab project: the office's prompts are put in GitLab's words and `glab`'s commands for those floors, including ones you rewrote in ⚙️ Settings.

What GitLab doesn't tell the boards in a list: how big a merge request is (the `+/−` counts show `0`).

## Your own GitLab sign-in

With accounts, everyone signs in to GitLab on their own, next to GitHub, under **☰ → 🔐 Your sign-ins** (see *Their own Claude, GitHub and GitLab* in the [README](../README.md)). Paste a personal access token (`api`, `read_repository` and `write_repository`) or run the office's sign-in, which uses `glab auth login --device`. Their token is kept in their own folder, `glab` runs there for them, and `git` pushes to GitLab as them. A person can be signed in to both forges, and each project uses the one it's on: commits to a GitLab remote carry their GitLab name and private email, commits to a GitHub one their GitHub's.

## Self-managed GitLab

gitlab.com, and any host named `gitlab.<something>`, are GitLab to the office without being told. Any other host is told with `AGENT_OFFICE_GITLAB_HOSTS` (several, separated by spaces or commas):

```bash
AGENT_OFFICE_GITLAB_HOSTS="git.example.com" agent-office
```

The office lists the projects of each of those hosts in the elevator, so `glab` has to be signed in to them (`glab auth login --hostname git.example.com`). Signing in from the office's own window (☰ → 🔐) is for gitlab.com: for a self-managed host, paste the token there only if it's the one you use, or sign in with `glab auth login --hostname …` in a 🐚 shell at a desk.
