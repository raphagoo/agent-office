import type { GhCheck, GhLabel, GhPull } from '../../shared/protocol.js';

// GitLab's REST answers, in the shapes the boards and windows show (which are GitHub's: OPEN, MERGED,
// CLEAN, a pass/fail/pending check). Pure, so each can be pinned by a test.

/** `opened`, `closed`, `merged` and `locked` (being merged), as the boards say them. */
export function stateOf(s: unknown): 'OPEN' | 'MERGED' | 'CLOSED' {
  const v = String(s ?? '').toLowerCase();
  if (v === 'merged') return 'MERGED';
  if (v === 'closed') return 'CLOSED';
  return 'OPEN';
}

/** Labels as a list answers them: names, or with `with_labels_details=true` objects with a color ("#428BCA"). */
export function labelsOf(raw: unknown): GhLabel[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((l): GhLabel[] => {
    if (typeof l === 'string') return [{ name: l, color: '#888888' }];
    if (l && typeof l === 'object' && typeof (l as { name?: unknown }).name === 'string') {
      const { name, color, description } = l as { name: string; color?: unknown; description?: unknown };
      return [{ name, color: typeof color === 'string' && /^#?[0-9a-f]{3,8}$/i.test(color) ? (color.startsWith('#') ? color : `#${color}`) : '#888888', ...(typeof description === 'string' && description ? { description } : {}) }];
    }
    return [];
  });
}

/** The words GitLab closes an issue on, by default: "Closes #12", "fixes #3", "Resolved #4", "Implements #5". */
const CLOSING = /\b(?:clos(?:e[sd]?|ing)|fix(?:e[sd]|ing)?|resolv(?:e[sd]?|ing)|implement(?:s|ed|ing)?)\s*:?\s+(?:issue\s+)?#(\d+)/gi;

/** The issues a merge request's description says it closes (the same words GitLab itself acts on). */
export function closesOf(description: unknown): number[] {
  const found = new Set<number>();
  for (const m of String(description ?? '').matchAll(CLOSING)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) found.add(n);
  }
  return [...found];
}

/** A pipeline's status as the PR card's checks dot shows it. A pipeline waiting on someone to start a job isn't running. */
export function pipelineChecks(status: unknown): GhPull['checks'] {
  const s = String(status ?? '').toLowerCase();
  if (!s) return 'none';
  if (s === 'success') return 'pass';
  if (s === 'failed' || s === 'canceled' || s === 'cancelled') return 'fail';
  if (s === 'skipped' || s === 'manual') return 'none';
  return 'pending';
}

/** One job of the merge request's pipeline, as a check. A job that failed but is allowed to doesn't fail the merge request. */
export function jobCheck(job: { name?: unknown; stage?: unknown; status?: unknown; allow_failure?: unknown; web_url?: unknown }): GhCheck {
  const s = String(job.status ?? '').toLowerCase();
  let state: GhCheck['state'] = 'pending';
  if (s === 'success') state = 'pass';
  else if (s === 'failed') state = job.allow_failure === true ? 'skip' : 'fail';
  else if (s === 'canceled' || s === 'cancelled') state = 'fail';
  else if (s === 'skipped' || s === 'manual') state = 'skip';
  const name = String(job.name ?? 'job');
  return { name: typeof job.stage === 'string' && job.stage ? `${job.stage} / ${name}` : name, state, url: typeof job.web_url === 'string' ? job.web_url : undefined };
}

/** GitLab's `detailed_merge_status` (and whether it conflicts) as GitHub's mergeable and mergeStateStatus, which the merge dialog reads. */
export function mergeStatusOf(detailed: unknown, hasConflicts: unknown, draft: unknown): { mergeable: string; mergeStateStatus: string } {
  const d = String(detailed ?? '').toLowerCase();
  if (hasConflicts === true || d === 'conflict') return { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
  if (!d || ['checking', 'unchecked', 'preparing', 'approvals_syncing'].includes(d)) return { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' };
  if (d === 'mergeable') return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
  if (d === 'draft_status' || draft === true) return { mergeable: 'MERGEABLE', mergeStateStatus: 'DRAFT' };
  if (d === 'need_rebase') return { mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' };
  if (d === 'broken_status') return { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
  // Needs a pipeline to pass, an approval, a resolved discussion…: it can merge once that's so.
  return { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' };
}

/** Whether the merge request still waits on an approval. */
export function reviewOf(detailed: unknown, approvedBy: number): string {
  if (approvedBy > 0) return 'APPROVED';
  return String(detailed ?? '').toLowerCase() === 'not_approved' ? 'REVIEW_REQUIRED' : '';
}

/** One file of GitLab's `diffs`: the hunks come without a header. */
export interface DiffFile {
  old_path?: string;
  new_path?: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
  a_mode?: string;
  b_mode?: string;
  diff?: string;
}

/** The merge request's files as `git diff` would print them, which is what the diff window reads. */
export function unifiedDiff(files: DiffFile[]): string {
  const out: string[] = [];
  for (const f of files) {
    const from = f.old_path ?? f.new_path ?? '';
    const to = f.new_path ?? f.old_path ?? '';
    out.push(`diff --git a/${from} b/${to}`);
    if (f.new_file) out.push(`new file mode ${f.b_mode && f.b_mode !== '0' ? f.b_mode : '100644'}`);
    else if (f.deleted_file) out.push(`deleted file mode ${f.a_mode && f.a_mode !== '0' ? f.a_mode : '100644'}`);
    else if (f.a_mode && f.b_mode && f.a_mode !== f.b_mode) out.push(`old mode ${f.a_mode}`, `new mode ${f.b_mode}`);
    if (f.renamed_file && from !== to) out.push('similarity index 100%', `rename from ${from}`, `rename to ${to}`);
    const hunks = f.diff ?? '';
    if (hunks.trim()) {
      out.push(f.new_file ? '--- /dev/null' : `--- a/${from}`, f.deleted_file ? '+++ /dev/null' : `+++ b/${to}`);
      out.push(hunks.endsWith('\n') ? hunks.slice(0, -1) : hunks);
    } else if (!f.new_file && !f.deleted_file && !f.renamed_file && (f.a_mode ?? '') === (f.b_mode ?? '')) {
      // No hunks, no rename, no mode change: a file git can't show as text.
      out.push(`Binary files a/${from} and b/${to} differ`);
    }
  }
  return out.length ? `${out.join('\n')}\n` : '';
}
