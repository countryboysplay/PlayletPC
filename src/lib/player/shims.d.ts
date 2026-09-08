/**
 * shims.d.ts - lets the dynamic import of the compiled shaka bundle typecheck
 * without pulling in shaka's own (version-churning) declaration file.
 *
 * Drop this file if you decide to depend on shaka-player's shipped typings.
 */
declare module 'shaka-player/dist/shaka-player.compiled.js' {
  const shaka: unknown;
  export default shaka;
}

declare module 'shaka-player/dist/shaka-player.ui.js' {
  const shaka: unknown;
  export default shaka;
}
