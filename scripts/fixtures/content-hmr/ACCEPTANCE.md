# Content HMR browser acceptance fixture

This is a verifier fixture plan, not the plugin implementation. Runtime
acceptance uses the built public package and `defineContentScript` client API.

## Observable fixture

- One `ISOLATED` entry and one `MAIN` entry target `/matching/*`.
- Each mounts one DOM root with a world label, revision, input, action button
  and timer counter. A local dependency supplies a separate revision label.
- Disposal saves the input through `data`, removes its root, clears its interval
  and unregisters its listener. Historical timer counters remain observable on
  the document so a removed but still running timer can be detected.
- The host has a separate input and state nonce. A separate extension page and
  service worker expose boot nonces. Navigation is counted with browser events.
- The HTTP server serves both regular and `script-src 'none'` matching pages,
  plus a `/nonmatching/` page. Script execution is inspected in both worlds,
  rather than inferring MAIN support from the output Manifest.

## Browser sequence and pass conditions

1. Build the plugin, start Vite with `contentScripts: { hmr: true }`, load its
   unpacked output in Chrome for Testing with Developer Mode enabled. Save
   browser version, public Manifest, SHA-256 tree digest and runtime errors.
2. Open two regular matching tabs and one nonmatching tab. Both matching tabs
   must mount each world exactly once; the nonmatching tab mounts neither.
   Save host inputs, content inputs, all boot nonces and navigation counts.
3. Change only each content entry, three times per world. Each tab presents
   revisions 1, 2 and 3 without navigation. Each world still has one root and
   the saved input. Dispatch one probe event and require one observed response.
   Old revision timer counters must freeze after cleanup.
4. Change only an exclusive imported dependency, then only CSS, then JS and CSS
   together. The dependency label and computed style update on both matching
   tabs. Navigation counts and background/page boot nonces remain unchanged.
   A single CSS revision must not accumulate duplicate style application.
5. Open a new matching tab after updates. It gets the current revision in both
   worlds. Keep the nonmatching tab unchanged. Repeat a delayed or duplicate
   update observation and ensure no additional mount or listener response.
6. Write invalid TypeScript. Wait for the build error, then assert the last
   successful revision still runs with unchanged mount count and boot nonces.
   Repair the entry and require the next revision on every matching tab.
7. Stop Vite; require the close promise to settle and temporary staging output
   to disappear. Restart on the same host/port. Change a content entry and
   require the already-open tabs to reconnect and update without navigation.
8. Repeat entry and CSS updates on a matching page with strict host CSP. Both
   worlds must update. Record browser/CDP script URLs: execution comes from
   packaged extension files, with no remote JavaScript or eval CSP exceptions.
9. Change background code and then Manifest, keeping content-only expectations
   separate. Each must cause the established full extension reload behavior.
   Unsupported shapes must provide a diagnostic and documented fallback.
10. Make a production build and inspect actual files and Manifest: no HMR
    transport, local development endpoint, inferred scripting permission,
    development host permission or development CSP remains. Repeat with
    explicit user permissions and confirm they survive.
11. `npm pack` the plugin, install the tarball into a fresh external project,
    import `@vite-react-chrome-extension/plugin/client`, then run TypeScript
    and Vite production build. Mount/stop remains usable; the browser bundle
    must not require Node builtins.

Each check reports PASS / FAIL / BLOCKED independently with its assertion or
browser observation. The final evidence digest is recorded after the final
build; any subsequent relevant source or artifact change requires revalidation.
