import { installDom as rawInstallDom } from '../dom-stub.js';
export * from '../dom-stub.js';

/** Project fixtures are explicitly /p/<id>/; root fixtures must keep using dom-stub directly. */
export function installDom({ fetch, projectId = 'aaaaaaaaaaaaaaaa' } = {}) {
  if (!/^[a-f0-9]{16}$/.test(projectId)) throw Error('invalid fixture project identity');
  const requests = [];
  const dom = rawInstallDom({ fetch: (url, options) => {
    const path = String(url); requests.push({ path, options });
    // Reuse the mock daemon's logical dispatcher, while retaining actual wire routes for routing assertions.
    return fetch(path.replace(/^\/p\/[a-f0-9]{16}(?=\/api(?:\/|$))/, ''), options);
  } });
  dom.location.pathname = `/p/${projectId}/`; dom.requests = requests;
  // Device automation also polls at 3000ms; project assertions exercise the last live timer, not the earlier global observer.
  dom.intervalFor = ms => dom.intervals.findLast(entry => entry.ms === ms)?.handler;
  return dom;
}
