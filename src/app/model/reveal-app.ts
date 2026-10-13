import type { App } from "vue";

/** How long the boot loader stays over the freshly mounted app. Rooms and
 *  channels come from the local cache in separate IndexedDB reads right after
 *  mount; the loader hides those first renders so the list appears in one go. */
export const APP_REVEAL_DELAY_MS = 350;

/**
 * Mount the app into `#app` while the boot loader keeps covering it, then
 * remove the loader after `delayMs`. `app.mount` replaces everything inside
 * `#app`, so the loader element is first moved out to `<body>` and raised
 * above the app's own overlays.
 */
export function revealApp(
  app: App,
  loadingApp: App,
  delayMs = APP_REVEAL_DELAY_MS,
): void {
  const loader = document.getElementById("appLoading");
  if (loader) {
    loader.style.position = "relative";
    loader.style.zIndex = "100000";
    document.body.appendChild(loader);
  }
  app.mount("#app");
  setTimeout(() => {
    loadingApp.unmount();
    loader?.remove();
  }, delayMs);
}
