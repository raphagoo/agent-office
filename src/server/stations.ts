// What the board agents are told when they're hired: the agents standing by the Issues board, the PR
// board and the task queue (STATIONS in shared/layout.ts). Whoever walks up types them a request; the
// first one follows this brief in the same prompt. The briefs themselves are prompts the office can
// rewrite in ⚙️ Settings (shared/prompts.ts).

import type { StationKind } from '../shared/layout.js';
import { projectForge } from './forge/index.js';
import { officePrompt, type PromptSource } from './prompts.js';

/** The agent's brief, in the words of the forge the project in `dir` is on (GitHub's when it isn't given). */
export function stationBrief(kind: StationKind, prompts?: PromptSource, dir?: string): string {
  return officePrompt(prompts, `station.${kind}`, {}, dir ? projectForge(dir) : undefined);
}

/** Claude Code tools the queue agent is launched without, so it can't edit the checkout even by mistake. */
export const QUEUE_AGENT_DISALLOWED_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
