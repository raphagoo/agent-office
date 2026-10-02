import type { ForgeKind } from './forge.js';

// The office's prompts are written for GitHub: "Review pull request #12 … gh pr view 12". On a
// GitLab project they say the same in GitLab's words and with glab's commands. Run on a prompt's
// template (never on what's filled into it, so an issue titled "fix gh pr view" stays that).

type Rule = [RegExp, string];

/** In order: the commands first, so the words after them are still the ones the commands were written with. */
const GITLAB: Rule[] = [
  // The line comments of a pull request are the discussions of a merge request.
  [/gh api repos\/\{\{repo\}\}\/pulls\/\{\{number\}\}\/comments/g, 'glab api projects/{{project}}/merge_requests/{{number}}/discussions'],
  [/\bgh pr checks \{\{(\w+)\}\} --watch\b/g, 'glab ci status --live'],
  [/\bgh pr checks\b(?: \{\{\w+\}\})?/g, 'glab ci status'],
  [/\bgh pr (view|diff|checkout|create|merge|close|list|comment|approve)\b/g, 'glab mr $1'],
  [/\bgh issue (view|list|create|close|reopen|comment|edit|note)\b/g, 'glab issue $1'],
  [/\bgh api\b/g, 'glab api'],
  [/\bthe gh CLI\b/g, 'the glab CLI'],
  [/\bgh\b/g, 'glab'],
  [/\bGitHub\b/g, 'GitLab'],
  [/\bpull requests\b/g, 'merge requests'],
  [/\bPull [Rr]equests\b/g, 'Merge Requests'],
  [/\bPull [Rr]equest\b/g, 'Merge request'],
  [/\bpull request\b/g, 'merge request'],
  [/\bPRs\b/g, 'MRs'],
  [/\bPR\b/g, 'MR'],
];

/** `text` in the words and commands of `forge`: as written for GitHub, or in GitLab's. */
export function forgeText(text: string, forge: ForgeKind | undefined): string {
  if (forge !== 'gitlab') return text;
  return GITLAB.reduce((t, [from, to]) => t.replace(from, to), text);
}
