import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from '@lydell/node-pty';
import { gitlabHosts, type ForgeKind } from '../shared/forge.js';
import type { SignInKind, SignInState, SignInsState } from '../shared/protocol.js';
import { seedClaude, trustFolders } from './signins-claude.js';
import { gitConfigText, type GitUser } from './signins-git.js';
import { kill, lastWords, plain, run } from './signins-util.js';

/*
 * Everyone's own Claude, GitHub and GitLab
 * ----------------------------------------
 * In an office with accounts, each person's workers run on that person's own Claude plan and
 * GitHub and GitLab accounts. Every account gets a folder, .agent-office/homes/<id>/, holding its own
 * Claude config (CLAUDE_CONFIG_DIR), gh config (GH_CONFIG_DIR), glab config (GLAB_CONFIG_DIR) and git
 * config (GIT_CONFIG_GLOBAL), and whatever runs for that account gets those in its environment in
 * place of the office's: its workers, and what the office does on GitHub or GitLab when they click
 * (comment, merge, open a PR). Nothing global changes, so any number of people can be signed in to
 * different accounts at once, and one person can be signed in to both GitHub and GitLab.
 *
 * Signing in happens from the office: it runs `claude auth login`, `gh auth login --web` or
 * `glab auth login --device` against the account's folders and hands the browser the page to open
 * (and the one-time code). A token from `claude setup-token`, or a GitHub or GitLab token, can be
 * pasted instead, and a shell at a desk runs with the same folders, so `claude auth login` typed there
 * works too. Admins may keep using the office machine's own sign-ins.
 *
 * An office without accounts (you alone, on the shared password) never comes here: everything runs
 * on the machine's own `claude`, `gh` and `glab`, exactly as before.
 */

/** Credentials the office's own environment may carry. None of them reach anything run as someone else. */
const CLAUDE_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'];
const FORGE_VARS: Record<ForgeKind, string[]> = {
  github: ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_CONFIG_DIR', 'GIT_CONFIG_GLOBAL'],
  gitlab: ['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN', 'CI_JOB_TOKEN', 'GLAB_CONFIG_DIR', 'GIT_CONFIG_GLOBAL'],
};
/** Where each forge CLI keeps its config, in an account's folder, and the variable that says so. */
const FORGE_DIR: Record<ForgeKind, { dir: string; env: string }> = { github: { dir: 'gh', env: 'GH_CONFIG_DIR' }, gitlab: { dir: 'glab', env: 'GLAB_CONFIG_DIR' } };
const FORGE_NAME: Record<ForgeKind, string> = { github: 'GitHub', gitlab: 'GitLab' };
const FORGES: ForgeKind[] = ['github', 'gitlab'];
/** GitHub's one-time codes last 15 minutes; a Claude sign-in link gets as long. */
const FLOW_MS = 15 * 60_000;
/** Someone's sign-ins are looked at again at most this often, unless they ask. */
const LOOK_GAP_MS = 20_000;
/** From `claude setup-token` (sk-ant-oat01-…), or an Anthropic API key (sk-ant-api03-…). */
const CLAUDE_TOKEN = /^sk-ant-[a-z]+\d*-[A-Za-z0-9_-]{20,}$/;
const API_KEY = /^sk-ant-api/;
/** ghp_…, github_pat_…, gho_… and the like; GitLab's glpat-… (it has dashes). */
const FORGE_TOKEN: Record<ForgeKind, RegExp> = { github: /^[A-Za-z0-9_]{20,255}$/, gitlab: /^[A-Za-z0-9_-]{20,255}$/ };
const TOKEN_HINT: Record<ForgeKind, string> = { github: 'ghp_…, github_pat_…', gitlab: 'glpat-…' };
const ACCOUNT_ID = /^[A-Za-z0-9]{6,64}$/;
const HELP_WHERE = '☰ → 🔐 Your sign-ins';

interface Saved {
  /** Unset: its own login, in its folder. A token pasted from `claude setup-token` (or an API key). The office machine's own (admins). */
  claude?: { use: 'token'; token: string } | { use: 'office' };
  github?: { use: 'office' };
  gitlab?: { use: 'office' };
  /** Who the last look found each signed in as, so workers can start before the next look. */
  seen?: Partial<Record<SignInKind, string>>;
  /** The name and private email of each forge login, for commits. */
  users?: Partial<Record<ForgeKind, GitUser>>;
}

/** A sign-in the office is running for someone. */
interface Flow {
  stop(): void;
  /** Types into it: the code from Claude's sign-in page. */
  write?(data: string): void;
}

interface Live {
  claude: Omit<SignInState, 'how'>;
  github: Omit<SignInState, 'how'>;
  gitlab: Omit<SignInState, 'how'>;
  flows: Partial<Record<SignInKind, Flow>>;
  looking?: Promise<void>;
  lookedAt: number;
}

/** Whose gh or glab the office runs for someone: their own sign-in's environment (`key` tells logins apart). */
export interface GhAs {
  key: string;
  env: Record<string, string>;
}

export class SignIns {
  private homes: string;
  private live = new Map<string, Live>();

  constructor(
    dataDir: string,
    /** The `claude`, `gh` and `glab` binaries, or null when they aren't installed. */
    private claude: string | null,
    private gh: string | null,
    private glab: string | null,
    /** The office's own environment, which everyone's is built on. */
    private base: () => Record<string, string>,
    /** Whether the account may use the office's own sign-ins (admins). */
    private mayUseOffice: (accountId: string) => boolean,
    private onChange: (accountId: string) => void,
  ) {
    this.homes = path.join(dataDir, 'homes');
  }

  state(id: string): SignInsState {
    const s = this.load(id);
    const l = this.get(id);
    return {
      claude: { ...l.claude, how: this.how(id, s, 'claude') },
      github: { ...l.github, how: this.how(id, s, 'github') },
      gitlab: { ...l.gitlab, how: this.how(id, s, 'gitlab') },
      office: this.mayUseOffice(id),
    };
  }

  /** Whether `id` has a Claude sign-in its workers can start on, as far as the last look knows. */
  claudeReady(id: string): boolean {
    const s = this.load(id);
    return this.how(id, s, 'claude') !== 'login' || !!s.seen?.claude;
  }

  /** Whether `id` has a GitHub or GitLab sign-in the office can act on it with (their own, as far as the last look knows, or the office's). */
  forgeReady(id: string, kind: ForgeKind): boolean {
    const s = this.load(id);
    return this.how(id, s, kind) === 'office' || !!s.seen?.[kind];
  }

  /** What to tell someone who needs `which` signed in first. */
  why(which: SignInKind): string {
    return which === 'claude' ? `Sign in to Claude first (${HELP_WHERE}): your workers run on your own Claude plan` : `Sign in to ${FORGE_NAME[which]} first (${HELP_WHERE}): the office acts on ${FORGE_NAME[which]} as you`;
  }

  /**
   * Changes whenever what `id`'s Claude signs in with changes (to read its plan's limits afresh).
   * Undefined when it's the office's own.
   */
  claudeKey(id: string): string | undefined {
    const s = this.load(id);
    const how = this.how(id, s, 'claude');
    if (how === 'office') return undefined;
    return `${how}:${s.claude?.use === 'token' ? s.claude.token.slice(-12) : ''}:${s.seen?.claude ?? ''}`;
  }

  /** The GitHub or GitLab login `id` acts as (for "you" on comments); undefined when it's the office's own or none. */
  login(id: string, kind: ForgeKind): string | undefined {
    const s = this.load(id);
    return this.how(id, s, kind) === 'login' ? s.seen?.[kind]?.replace(/^@/, '') : undefined;
  }

  /**
   * Puts `id`'s own sign-ins in place of the office's in `env` (changed in place, and returned).
   * `dirs` are where a worker is about to start, to carry over the office's folder trust.
   */
  apply(id: string, env: Record<string, string>, dirs: string[] = [], only?: SignInKind): Record<string, string> {
    const s = this.load(id);
    const home = this.prepare(id);
    if ((!only || only === 'claude') && this.how(id, s, 'claude') !== 'office') {
      for (const k of CLAUDE_VARS) delete env[k];
      env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
      if (s.claude?.use === 'token') env[API_KEY.test(s.claude.token) ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN'] = s.claude.token;
      if (dirs.length) trustFolders(this.base(), env.CLAUDE_CONFIG_DIR, dirs);
    }
    for (const kind of FORGES) {
      if ((only && only !== kind) || this.how(id, s, kind) === 'office') continue;
      for (const k of FORGE_VARS[kind]) delete env[k];
      env[FORGE_DIR[kind].env] = path.join(home, FORGE_DIR[kind].dir);
      env.GIT_CONFIG_GLOBAL = path.join(home, 'gitconfig');
    }
    return env;
  }

  /** How the office runs gh (or glab, for a GitLab project) for `id`: as them (GhAs), as itself (undefined, an admin's choice), or a reason it can't. */
  ghAs(id: string, kind: ForgeKind = 'github'): GhAs | undefined | string {
    const s = this.load(id);
    if (this.how(id, s, kind) === 'office') return undefined;
    if (!s.seen?.[kind]) return this.why(kind);
    // Both forges' logins go in: a worker across repositories may have a pull request on each.
    const env = this.base();
    for (const k of FORGES) this.apply(id, env, [], k);
    return { key: id, env };
  }

  /** Looks at who `id` is signed in as, now if `force`, else unless it just did. */
  look(id: string, force = false): Promise<void> {
    const l = this.get(id);
    if (l.looking) return l.looking;
    if (!force && Date.now() - l.lookedAt < LOOK_GAP_MS) return Promise.resolve();
    l.looking = Promise.all([this.lookClaude(id), ...FORGES.map((k) => this.lookForge(id, k))]).then(() => {
      l.lookedAt = Date.now();
      l.looking = undefined;
      this.onChange(id);
    });
    return l.looking;
  }

  /** Starts signing `id` in from the office. The page to open comes through state(). Returns why it can't. */
  start(id: string, which: SignInKind): string | undefined {
    return which === 'claude' ? this.startClaude(id) : this.startForge(id, which);
  }

  /** The code Claude's sign-in page showed, typed in where `claude auth login` waits for it. */
  code(id: string, code: string): string | undefined {
    const l = this.get(id);
    const flow = l.flows.claude;
    if (!flow?.write) return 'Start signing in to Claude first';
    const clean = code.trim();
    if (!/^[A-Za-z0-9#_.~-]{8,2048}$/.test(clean)) return "That doesn't look like the code from Claude's sign-in page";
    flow.write(`${clean}\r`);
    l.claude = { ...l.claude, pending: { ...l.claude.pending, sent: true }, error: undefined };
    this.onChange(id);
    return undefined;
  }

  cancel(id: string, which: SignInKind) {
    this.stop(id, which);
    void this.look(id, true);
  }

  /** A pasted token: from `claude setup-token` (or an API key), or a GitHub or GitLab token. Resolves to why it didn't take. */
  async token(id: string, which: SignInKind, raw: string): Promise<string | undefined> {
    const token = raw.trim();
    this.stop(id, which);
    if (which === 'claude') {
      if (!CLAUDE_TOKEN.test(token)) return "That isn't a token from `claude setup-token` (sk-ant-oat01-…) or an Anthropic API key (sk-ant-api03-…)";
      const s = this.load(id);
      s.claude = { use: 'token', token };
      this.save(id, s);
      // Claude asks once before it uses an API key from the environment; this one is theirs, so it's approved.
      if (API_KEY.test(token)) {
        seedClaude(path.join(this.prepare(id), 'claude'), (c) => {
          c.customApiKeyResponses ??= { approved: [], rejected: [] };
          const tail = token.slice(-20);
          if (!c.customApiKeyResponses.approved.includes(tail)) c.customApiKeyResponses.approved.push(tail);
        });
      }
      await this.look(id, true);
      return undefined;
    }
    const bin = this.bin(which);
    const name = FORGE_NAME[which];
    if (!bin) return `The ${name} CLI (${which === 'github' ? 'gh' : 'glab'}) isn't installed on the office's machine`;
    if (!FORGE_TOKEN[which].test(token)) return `That doesn't look like a ${name} token (${TOKEN_HINT[which]})`;
    const s = this.load(id);
    delete s[which];
    this.save(id, s);
    const login = which === 'github' ? ['auth', 'login', '--hostname', 'github.com', '--with-token', '--insecure-storage'] : ['auth', 'login', '--hostname', gitlabHosts()[0], '--stdin', '--git-protocol', 'https', '--insecure-storage'];
    const r = await run(bin, login, this.forgeEnv(id, which), `${token}\n`);
    await this.look(id, true);
    return r.code === 0 ? undefined : `${name} didn't take that token: ${r.last || `${which === 'github' ? 'gh' : 'glab'} auth login failed`}`;
  }

  /** Uses the office machine's own sign-in (admins only). */
  useOffice(id: string, which: SignInKind): string | undefined {
    if (!this.mayUseOffice(id)) return "Only admins can use the office's own sign-ins";
    this.stop(id, which);
    const s = this.load(id);
    s[which] = { use: 'office' };
    this.save(id, s);
    void this.look(id, true);
    return undefined;
  }

  async signOut(id: string, which: SignInKind) {
    this.stop(id, which);
    const s = this.load(id);
    const how = this.how(id, s, which);
    if (how === 'login') await this.logout(id, which);
    delete s[which];
    if (s.seen) delete s.seen[which];
    if (s.users && which !== 'claude') delete s.users[which];
    this.save(id, s);
    if (which !== 'claude') this.writeGitConfig(id);
    await this.look(id, true);
  }

  /** An account is gone: sign its logins out and delete its folder. */
  forget(id: string) {
    if (!ACCOUNT_ID.test(id)) return;
    for (const which of ['claude', ...FORGES] as SignInKind[]) this.stop(id, which);
    this.live.delete(id);
    const home = path.join(this.homes, id);
    if (!existsSync(home)) return;
    // On a Mac, Claude keeps the login in the keychain, not the folder: sign out so it goes too.
    void this.logout(id, 'claude').finally(() => {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch (err) {
        console.error(`agent-office: couldn't delete ${home}: ${(err as Error).message}`);
      }
    });
  }

  /** Deletes the folders of accounts that no longer exist (revoked from the terminal meanwhile). */
  prune(accounts: Set<string>) {
    let names: string[];
    try {
      names = readdirSync(this.homes);
    } catch {
      return;
    }
    for (const n of names) if (ACCOUNT_ID.test(n) && !accounts.has(n)) this.forget(n);
  }

  shutdown() {
    for (const [id] of this.live) for (const which of ['claude', ...FORGES] as SignInKind[]) this.stop(id, which);
  }

  // ---------------------------------------------------------------------------

  /** How `which` signs `id` in. A demoted admin's 'office' no longer counts: back to their own. */
  private how(id: string, s: Saved, which: SignInKind): SignInState['how'] {
    const use = s[which]?.use;
    if (use === 'office') return this.mayUseOffice(id) ? 'office' : 'login';
    return use === 'token' ? 'token' : 'login';
  }

  private bin(kind: ForgeKind): string | null {
    return kind === 'github' ? this.gh : this.glab;
  }

  private get(id: string): Live {
    let l = this.live.get(id);
    if (!l) {
      const seen = this.load(id).seen ?? {};
      const of = (k: SignInKind): Omit<SignInState, 'how'> => (seen[k] ? { status: 'ok', who: seen[k] } : { status: 'none' });
      l = { claude: of('claude'), github: of('github'), gitlab: of('gitlab'), flows: {}, lookedAt: 0 };
      this.live.set(id, l);
    }
    return l;
  }

  private home(id: string): string {
    if (!ACCOUNT_ID.test(id)) throw new Error(`not an account id: ${id}`);
    return path.join(this.homes, id);
  }

  /** The account's folder, made on first use. */
  private prepare(id: string): string {
    const home = this.home(id);
    if (!existsSync(path.join(home, 'gitconfig'))) {
      for (const d of [this.homes, home, path.join(home, 'claude'), path.join(home, 'gh')]) mkdirSync(d, { recursive: true, mode: 0o700 });
      seedClaude(path.join(home, 'claude'));
      this.writeGitConfig(id);
    }
    // A folder made before GitLab was there has no glab config yet.
    if (!existsSync(path.join(home, 'glab'))) mkdirSync(path.join(home, 'glab'), { recursive: true, mode: 0o700 });
    return home;
  }

  private load(id: string): Saved {
    try {
      const s = JSON.parse(readFileSync(path.join(this.home(id), 'signins.json'), 'utf8')) as Saved;
      return s && typeof s === 'object' ? s : {};
    } catch {
      return {};
    }
  }

  private save(id: string, s: Saved) {
    this.prepare(id);
    try {
      writeFileSync(path.join(this.home(id), 'signins.json'), JSON.stringify(s, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error(`agent-office: couldn't save ${id}'s sign-ins: ${(err as Error).message}`);
    }
  }

  private stop(id: string, which: SignInKind) {
    const l = this.live.get(id);
    const flow = l?.flows[which];
    if (!l || !flow) return;
    delete l.flows[which];
    flow.stop();
    l[which] = { ...l[which], status: l[which].who ? 'ok' : 'none', pending: undefined };
  }

  /** The environment for `claude` run as `id`'s own login (never a pasted token or the office's). */
  private claudeEnv(id: string): Record<string, string> {
    const env = this.base();
    for (const k of CLAUDE_VARS) delete env[k];
    env.CLAUDE_CONFIG_DIR = path.join(this.prepare(id), 'claude');
    return env;
  }

  /** The environment for `gh` or `glab` run as `id`'s own login. */
  private forgeEnv(id: string, kind: ForgeKind): Record<string, string> {
    const env = this.base();
    for (const k of FORGE_VARS[kind]) delete env[k];
    const home = this.prepare(id);
    env[FORGE_DIR[kind].env] = path.join(home, FORGE_DIR[kind].dir);
    env.GIT_CONFIG_GLOBAL = path.join(home, 'gitconfig');
    return env;
  }

  private startClaude(id: string): string | undefined {
    if (!this.claude) return "Claude Code isn't installed where the office can run it — paste a token from `claude setup-token` instead";
    this.stop(id, 'claude');
    const l = this.get(id);
    // BROWSER=true: Claude "opens" the page with the `true` command and just prints it, for the browser to show.
    const env = { ...this.claudeEnv(id), BROWSER: 'true', TERM: 'xterm-256color' };
    let p: pty.IPty;
    try {
      // Wide, so the link comes out on one line.
      p = pty.spawn(this.claude, ['auth', 'login', '--claudeai'], { name: 'xterm-256color', cols: 4000, rows: 40, cwd: this.home(id), env });
    } catch (err) {
      return `Couldn't start Claude Code's sign-in: ${(err as Error).message}`;
    }
    let out = '';
    /** Where the output after the code was sent starts, to tell a wrong code apart from the first ask. */
    let sentAt = -1;
    const flow: Flow = {
      stop: () => kill(p),
      write: (data) => {
        sentAt = out.length;
        p.write(data);
      },
    };
    const timer = setTimeout(flow.stop, FLOW_MS);
    p.onData((d) => {
      out = (out + d).slice(-50_000);
      if (l.flows.claude !== flow) return;
      const text = plain(out);
      if (!l.claude.pending?.url) {
        const url = /https:\/\/\S*oauth\/authorize\?\S+/.exec(text)?.[0];
        if (url) {
          l.claude = { status: 'busy', pending: { url } };
          this.onChange(id);
        }
      } else if (sentAt >= 0 && /error|invalid|expired|failed/i.test(plain(out.slice(sentAt)))) {
        // Still running after complaining: the code didn't take, and it waits for another.
        const said = lastWords(out.slice(sentAt));
        sentAt = -1;
        l.claude = { status: 'busy', pending: { url: l.claude.pending.url }, error: said || "That code didn't work — copy it again, or start over" };
        this.onChange(id);
      }
    });
    p.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (l.flows.claude !== flow) return;
      delete l.flows.claude;
      if (exitCode === 0) {
        // Signed in with its own login: that's what its workers use from now on.
        const s = this.load(id);
        delete s.claude;
        this.save(id, s);
        l.claude = { status: 'busy' };
      } else l.claude = { status: 'none', error: lastWords(out) || 'Signing in stopped before it finished' };
      this.onChange(id);
      void this.look(id, true);
    });
    l.flows.claude = flow;
    l.claude = { status: 'busy', pending: {} };
    this.onChange(id);
    return undefined;
  }

  /** `gh auth login --web` or `glab auth login --device`: over pipes, they print the one-time code and the page, then wait for the forge to say yes. */
  private startForge(id: string, kind: ForgeKind): string | undefined {
    const bin = this.bin(kind);
    const name = FORGE_NAME[kind];
    if (!bin) return `The ${name} CLI (${kind === 'github' ? 'gh' : 'glab'}) isn't installed on the office's machine`;
    this.stop(id, kind);
    const l = this.get(id);
    const env = { ...this.forgeEnv(id, kind), BROWSER: 'true', GH_BROWSER: 'true' };
    const args =
      kind === 'github'
        ? ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--insecure-storage', '--skip-ssh-key']
        : ['auth', 'login', '--hostname', gitlabHosts()[0], '--device', '--git-protocol', 'https', '--insecure-storage'];
    const p = spawn(bin, args, { cwd: this.home(id), env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const flow: Flow = { stop: () => kill(p) };
    const timer = setTimeout(flow.stop, FLOW_MS);
    const onData = (d: Buffer) => {
      out = (out + d.toString('utf8')).slice(-20_000);
      if (l.flows[kind] !== flow || l[kind].pending?.url) return;
      const text = plain(out);
      if (kind === 'github') {
        const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(out)?.[1];
        if (!code) return;
        l.github = { status: 'busy', pending: { url: /https:\/\/github\.com\/login\/device\S*/.exec(out)?.[0] ?? 'https://github.com/login/device', code } };
      } else {
        // glab prints the page to open and, unless the address carries it, the code to type there.
        const url = /https:\/\/\S+/.exec(text)?.[0]?.replace(/[.,)]+$/, '');
        if (!url) return;
        l.gitlab = { status: 'busy', pending: { url, code: /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(text)?.[1] } };
      }
      this.onChange(id);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (err) => {
      if (l.flows[kind] !== flow) return;
      delete l.flows[kind];
      clearTimeout(timer);
      l[kind] = { status: 'none', error: `Couldn't start ${kind === 'github' ? 'gh' : 'glab'}: ${err.message}` };
      this.onChange(id);
    });
    p.on('exit', (exitCode) => {
      clearTimeout(timer);
      if (l.flows[kind] !== flow) return;
      delete l.flows[kind];
      if (exitCode === 0) {
        const s = this.load(id);
        delete s[kind];
        this.save(id, s);
        l[kind] = { status: 'busy' };
      } else l[kind] = { status: 'none', error: lastWords(out) || 'Signing in stopped before it finished' };
      this.onChange(id);
      void this.look(id, true);
    });
    l.flows[kind] = flow;
    l[kind] = { status: 'busy', pending: {} };
    this.onChange(id);
    return undefined;
  }

  private async lookClaude(id: string) {
    const l = this.get(id);
    if (l.flows.claude) return;
    const s = this.load(id);
    const how = this.how(id, s, 'claude');
    if (!this.claude) {
      l.claude = how === 'token' ? { status: 'ok', who: 'a pasted token' } : { status: 'none', error: "Claude Code isn't installed on the office's machine" };
      return;
    }
    const env = how === 'office' ? this.base() : this.apply(id, this.base(), [], 'claude');
    const r = await run(this.claude, ['auth', 'status', '--json'], env);
    let status: { loggedIn?: boolean; email?: string; subscriptionType?: string; authMethod?: string } = {};
    try {
      status = JSON.parse(r.out);
    } catch {
      // older Claude Code, or it failed: nothing to go on
    }
    if (l.flows.claude) return;
    const plan = status.subscriptionType ? ` · ${status.subscriptionType[0].toUpperCase()}${status.subscriptionType.slice(1)}` : '';
    const pasted = s.claude?.use === 'token' ? (API_KEY.test(s.claude.token) ? 'an API key' : 'a token from claude setup-token') : 'a token';
    // A token in the environment is taken on trust: whether it works shows when a worker starts.
    const who = status.loggedIn || how === 'token' ? `${status.email ?? pasted}${plan}` : undefined;
    // Signed out, `claude auth status` still answers (and exits 1); anything else went wrong.
    l.claude = who ? { status: 'ok', who } : { status: 'none', error: r.out ? undefined : r.last || undefined };
    this.remember(id, 'claude', how === 'office' ? undefined : who);
  }

  private async lookForge(id: string, kind: ForgeKind) {
    const l = this.get(id);
    if (l.flows[kind]) return;
    const s = this.load(id);
    const how = this.how(id, s, kind);
    const bin = this.bin(kind);
    const cli = kind === 'github' ? 'gh' : 'glab';
    if (!bin) {
      l[kind] = { status: 'none', error: `The ${FORGE_NAME[kind]} CLI (${cli}) isn't installed on the office's machine` };
      return;
    }
    const args = kind === 'github' ? ['api', 'user', '--jq', '{login, id, name}'] : ['api', 'user', '--hostname', gitlabHosts()[0]];
    const r = await run(bin, args, how === 'office' ? this.base() : this.forgeEnv(id, kind));
    if (l.flows[kind]) return;
    let user: { login?: string; username?: string; id?: number; name?: string | null } = {};
    try {
      user = r.code === 0 ? JSON.parse(r.out) : {};
    } catch {
      // not JSON: treated as not signed in
    }
    const login = user.login ?? user.username;
    if (login) {
      l[kind] = { status: 'ok', who: `@${login}` };
      if (how !== 'office') this.rememberUser(id, kind, { name: user.name?.trim() || login, email: kind === 'github' ? `${user.id}+${login}@users.noreply.github.com` : `${user.id}-${login}@users.noreply.gitlab.com` });
    } else {
      const signedOut = /auth login|not logged in|authenticat|401|unauthorized|bad credentials/i.test(r.last);
      l[kind] = { status: 'none', error: signedOut || !r.last ? undefined : r.last };
    }
    this.remember(id, kind, how === 'office' ? undefined : l[kind].who);
  }

  /** Keeps who the last look found, for the next start of the office. */
  private remember(id: string, which: SignInKind, who: string | undefined) {
    const s = this.load(id);
    if ((s.seen?.[which] ?? undefined) === who) return;
    s.seen = { ...s.seen, [which]: who };
    if (!who) delete s.seen[which];
    this.save(id, s);
  }

  /** Keeps the name and private email of a forge login for commits, and writes them into the account's git config. */
  private rememberUser(id: string, kind: ForgeKind, user: GitUser) {
    const s = this.load(id);
    if (s.users?.[kind]?.name === user.name && s.users[kind]?.email === user.email) return;
    s.users = { ...s.users, [kind]: user };
    this.save(id, s);
    this.writeGitConfig(id);
  }

  private async logout(id: string, which: SignInKind) {
    if (which === 'claude') {
      if (this.claude) await run(this.claude, ['auth', 'logout'], this.claudeEnv(id));
      return;
    }
    const bin = this.bin(which);
    if (bin) await run(bin, which === 'github' ? ['auth', 'logout', '--hostname', 'github.com'] : ['auth', 'logout', '--hostname', gitlabHosts()[0]], this.forgeEnv(id, which));
    rmSync(path.join(this.home(id), FORGE_DIR[which].dir, which === 'github' ? 'hosts.yml' : 'config.yml'), { force: true });
  }

  /** The account's git config (see signins-git.ts): the office's own, the forges' credentials and the identities found. */
  private writeGitConfig(id: string) {
    const home = this.home(id);
    const base = this.base();
    const xdg = base.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    const includes = base.GIT_CONFIG_GLOBAL ? [base.GIT_CONFIG_GLOBAL] : [path.join(xdg, 'git', 'config'), path.join(os.homedir(), '.gitconfig')];
    const gitlabFile = path.join(home, 'gitconfig-gitlab');
    const text = gitConfigText({ includes, bins: { github: this.gh ?? undefined, gitlab: this.glab ?? undefined }, gitlabHosts: gitlabHosts(), users: this.load(id).users ?? {}, gitlabFile });
    const put = (file: string, content: string | undefined) => {
      try {
        if (content === undefined) rmSync(file, { force: true });
        else if (!existsSync(file) || readFileSync(file, 'utf8') !== content) writeFileSync(file, content, { mode: 0o600 });
      } catch (err) {
        console.error(`agent-office: couldn't write ${file}: ${(err as Error).message}`);
      }
    };
    put(path.join(home, 'gitconfig'), text.main);
    put(gitlabFile, text.gitlab);
  }
}
