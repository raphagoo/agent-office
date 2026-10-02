import { FORGES, forgeOf, forgeOfUrl, type ForgeMeta } from '../../../shared/forge';
import { store } from '../../state';

// Which forge the windows are about, for what they call things: a pull request on GitHub, a merge
// request on GitLab. A window about one issue or pull request knows it by its address; the rest
// (the boards, the queue) by the floor you're on.

/** The forge an issue or pull request is on, from its address. */
export const forgeOfItem = (url: string): ForgeMeta => FORGES[forgeOfUrl(url)];

/** The forge of the floor you're on. */
export const floorForge = (): ForgeMeta => FORGES[forgeOf(store.currentFloor()?.repo)];
