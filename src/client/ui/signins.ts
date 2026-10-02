import './signins.css';
import type { SignInKind, SignInState } from '../../shared/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, type Modal } from './dom';
import { confirmDialog } from './prompt';
import { copyButton } from './team';

const NAMES: Record<SignInKind, string> = { claude: 'Claude', github: 'GitHub', gitlab: 'GitLab' };
const ICONS: Record<SignInKind, string> = { claude: '✳️', github: '🐙', gitlab: '🦊' };
/** Where a GitHub or GitLab token is made: the page, and what to give it. */
const TOKEN_HELP: Record<'github' | 'gitlab', { href: string; scopes: string }> = {
  github: { href: 'https://github.com/settings/tokens/new?scopes=repo,read:org,workflow&description=Agent%20Office', scopes: 'repo, read:org and workflow' },
  gitlab: { href: 'https://gitlab.com/-/user_settings/personal_access_tokens?name=Agent%20Office&scopes=api,read_repository,write_repository', scopes: 'api, read_repository and write_repository' },
};

let open: { modal: Modal; say(why?: string): void } | null = null;

/**
 * 🔐 Your sign-ins: the Claude plan your workers run on and the GitHub account the office acts as
 * for you, both your own (see server/signins.ts). The office runs the sign-in itself and hands you
 * the page to open; or paste a token; admins may use the office machine's own instead.
 * `why` says what sent you here (hiring a worker before signing in, say).
 */
export function openSignIns(net: Net, why?: string) {
  if (open) return open.say(why);
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const banner = h('p.team-status', { hidden: true });
  const cards = h('div.signins');
  const el = h(
    'div.modal',
    { role: 'dialog', 'aria-label': 'Your sign-ins', style: 'width:min(640px,100%)' },
    h('header', {}, h('h2', {}, '🔐 Your sign-ins'), close),
    h(
      'div.body.team',
      {},
      h('p.note.lead', {}, 'Your workers run on your own Claude plan, and the office acts on GitHub and GitLab as you: comments, merges and pull requests (merge requests on GitLab) show up under your name. Only your workers use them. Sign in to the ones you use: each project uses the one it is on.'),
      banner,
      cards,
      h('p.note', {}, 'Or open a 🐚 shell at any desk: it runs as you, so ', h('code', {}, 'claude auth login'), ', ', h('code', {}, 'gh auth login'), ' and ', h('code', {}, 'glab auth login'), ' typed there sign you in too.'),
    ),
  );

  // Kept across renders, so a half-typed code or token survives the next update.
  const inputs = {
    code: h('input', { type: 'text', placeholder: 'Paste the code here', 'aria-label': 'Code from the sign-in page', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement,
    claude: h('input', { type: 'password', placeholder: 'sk-ant-oat01-…', 'aria-label': 'Claude token', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement,
    github: h('input', { type: 'password', placeholder: 'ghp_… or github_pat_…', 'aria-label': 'GitHub token', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement,
    gitlab: h('input', { type: 'password', placeholder: 'glpat-…', 'aria-label': 'GitLab token', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement,
  };

  const say = (text?: string) => {
    banner.hidden = !text;
    banner.textContent = text ?? '';
  };

  const button = (label: string, onClick: () => void, cls = '') => {
    const b = h('button.btn', { type: 'button', class: cls }, label);
    b.addEventListener('click', onClick);
    return b;
  };

  const tokenRow = (which: SignInKind) => {
    const input = inputs[which];
    const save = h('button.btn', { type: 'submit' }, 'Save');
    const form = h('form.invite-row', {}, input, save) as HTMLFormElement;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const token = input.value.trim();
      if (!token) return input.focus();
      net.send({ t: 'signins.token', which, token });
      input.value = '';
    });
    return form;
  };

  const card = (which: SignInKind, s: SignInState, office: boolean) => {
    const status =
      s.status === 'ok'
        ? h('span.signin-who.ok', {}, '✅ ', s.how === 'office' ? `The office’s own${s.who ? ` (${s.who})` : ''}` : (s.who ?? 'Signed in'))
        : s.status === 'busy'
          ? h('span.signin-who', {}, '⏳ Signing in…')
          : h('span.signin-who.none', {}, 'Not signed in');
    const head = h('div.team-head', {}, h('h4', {}, `${ICONS[which]} ${NAMES[which]}`), status);
    const body = h('div.signin-body');
    const box = h('section.signin', { class: s.status }, head, body);
    if (s.error) body.append(h('p.team-status.error', {}, s.error));

    if (s.pending) {
      const url = s.pending.url && /^https:\/\//.test(s.pending.url) ? s.pending.url : undefined;
      if (!url) {
        body.append(h('p.note', {}, `Starting ${NAMES[which]}’s sign-in…`));
      } else if (which === 'claude') {
        const send = h('button.btn.primary', { type: 'submit' }, s.pending.sent ? 'Checking…' : 'Send');
        if (s.pending.sent) send.setAttribute('disabled', '');
        const form = h('form.invite-row', {}, inputs.code, send) as HTMLFormElement;
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const code = inputs.code.value.trim();
          if (!code) return inputs.code.focus();
          net.send({ t: 'signins.code', code });
          inputs.code.value = '';
        });
        body.append(
          h('ol.signin-steps', {}, h('li', {}, h('a.btn.primary', { href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Open Claude’s sign-in page ↗'), ' and sign in with your own account.'), h('li', {}, 'It shows you a code. Paste it here:', form)),
        );
      } else {
        const code = s.pending.code ?? '';
        // GitLab's page may carry the code in its address, so there's none to copy first.
        body.append(
          h(
            'ol.signin-steps',
            {},
            code ? h('li', {}, 'Copy your one-time code:', h('div.cmd', {}, h('pre.signin-code', {}, code), copyButton('Copy', () => code))) : null,
            h('li', {}, h('a.btn.primary', { href: url, target: '_blank', rel: 'noopener noreferrer' }, `Open ${new URL(url).host}${which === 'github' ? '/login/device' : ''} ↗`), code ? ' and enter it there.' : ' and sign in with your own account.'),
            h('li', {}, `This updates by itself once ${NAMES[which]} says yes.`),
          ),
        );
      }
      body.append(h('div.signin-actions', {}, button('Cancel', () => net.send({ t: 'signins.cancel', which }))));
      return box;
    }

    if (s.status === 'ok') {
      const change = button(s.how === 'office' ? 'Use my own instead' : 'Sign out', () => {
        if (s.how === 'office') return net.send({ t: 'signins.signout', which });
        confirmDialog(`Sign out of ${NAMES[which]}?`, which === 'claude' ? 'Workers you hire from now on need a new sign-in. The ones already running keep going.' : `The office stops acting on ${NAMES[which]} as you until you sign in again.`, 'Sign out', () => net.send({ t: 'signins.signout', which }));
      });
      body.append(h('div.signin-actions', {}, change));
      return box;
    }

    // Not signed in (or busy looking): the ways in.
    const start = button(`Sign in with ${NAMES[which]}`, () => net.send({ t: 'signins.start', which }), 'primary');
    const actions = h('div.signin-actions', {}, start);
    if (office) actions.append(button('Use the office’s own', () => net.send({ t: 'signins.office', which })));
    body.append(
      actions,
      which === 'claude'
        ? h('p.note', {}, 'Or paste a token: run ', h('code', {}, 'claude setup-token'), ' on your own computer (or use an Anthropic API key).')
        : h('p.note', {}, `Or paste a ${NAMES[which]} token (`, h('a', { href: TOKEN_HELP[which].href, target: '_blank', rel: 'noopener noreferrer' }, 'make one'), ` with ${TOKEN_HELP[which].scopes}).`),
      tokenRow(which),
    );
    return box;
  };

  const render = () => {
    const s = store.signins;
    const typing = document.activeElement;
    cards.replaceChildren();
    if (!s) {
      cards.append(h('p.empty', {}, store.me.account ? 'Loading…' : 'On the shared office password, workers run on the office’s own sign-ins.'));
      return;
    }
    cards.append(card('claude', s.claude, s.office), card('github', s.github, s.office), card('gitlab', s.gitlab, s.office));
    if (typing instanceof HTMLInputElement && Object.values(inputs).includes(typing) && typing.isConnected) typing.focus();
    // Once Claude and the forge you use are sorted, whatever sent you here is too.
    if (s.claude.status === 'ok' && (s.github.status === 'ok' || s.gitlab.status === 'ok')) say();
  };

  const unsub = store.on('signins', render);
  const modal = openModal(el, {
    onClose: () => {
      unsub();
      open = null;
    },
  });
  close.addEventListener('click', () => modal.close());
  open = { modal, say };
  say(why);
  render();
  net.send({ t: 'signins.get' });
}

/** Whether the panel should greet someone who just came in: their Claude sign-in still to do. */
export function needsSigningIn(): boolean {
  const s = store.signins;
  return !!store.me.account && !!s && s.claude.status === 'none' && s.claude.how === 'login';
}
