/**
 * What this browser page already knows about Google's Maps JavaScript API.
 *
 * Kept apart from the components that draw a map (`RouteMap`, `RouteLineMap`,
 * `MapKeyProbe`) so it costs nothing to import: it does not pull in
 * `@vis.gl/react-google-maps`, which only those three files may load (lazily).
 *
 * Two page-wide facts live here, because Google's script is page-wide too:
 *
 *   · **An authentication failure.** A key Google refuses (wrong referrer, Maps JavaScript
 *     API not enabled, bad key, billing) is reported through ONE global callback,
 *     `window.gm_authFailure`, with no argument. The map library (1.10.1) declares an
 *     `AUTH_FAILURE` status but never sets it — nothing in its `dist/` calls
 *     `updateLoadingStatus(AUTH_FAILURE)` or installs the callback — so without this the
 *     only sign of a refused key would be Google's grey "something went wrong" box. Once
 *     it has fired, every later map on the page fails the same way: the script is loaded
 *     once, with that key.
 *   · **The key the script was loaded with.** The library loads the script once per page
 *     and ignores different parameters afterwards (`useGoogleMapsApiLoader`: "The new
 *     parameters will be ignored … please refresh the page"). The admin check needs to
 *     know that, or a second key typed into the form would be "checked" with the first.
 */

type Listener = () => void;

const listeners = new Set<Listener>();
let installed = false;
let authFailed = false;
let loadedKey: string | null = null;

type AuthFailureWindow = Window & { gm_authFailure?: () => void };

/** Install the global callback once, keeping whatever was there before. */
function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const w = window as AuthFailureWindow;
  const previous = w.gm_authFailure;
  w.gm_authFailure = () => {
    authFailed = true;
    previous?.();
    for (const listener of [...listeners]) listener();
  };
}

/**
 * Be told when Google refuses the key. Returns the unsubscribe. A failure that already
 * happened on this page is reported straight away (on the next tick), since the script
 * will not load again to repeat it.
 */
export function onMapsAuthFailure(listener: Listener): () => void {
  install();
  if (authFailed) {
    const id = setTimeout(listener, 0);
    return () => clearTimeout(id);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Note the key a map is about to load with. `'same'` when the page's script uses (or will
 * use) this key; `'other'` when it was already loaded with a different one, in which case
 * the library will not load it again and the map would run on that other key.
 */
export function claimMapsKey(key: string): 'same' | 'other' {
  if (loadedKey === null) loadedKey = key;
  return loadedKey === key ? 'same' : 'other';
}

/** Tests only: forget everything, as a fresh page would. */
export function resetMapsPageForTests(): void {
  listeners.clear();
  installed = false;
  authFailed = false;
  loadedKey = null;
  if (typeof window !== 'undefined') delete (window as AuthFailureWindow).gm_authFailure;
}
