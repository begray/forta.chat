import { watch } from "vue";
import { useRoute, useRouter, type LocationQuery, type LocationQueryRaw } from "vue-router";
import { useSidebarTab, type SettingsSubView, type SidebarTab } from "./use-sidebar-tab";

/**
 * Mirrors the sidebar tab and the settings sub-view into the /chat route query
 * (`?tab=settings&section=profile`), so opening Contacts, Settings or a
 * settings section is a history entry and Back (browser, mouse, gesture)
 * steps out of it instead of leaving the chat page.
 *
 * The refs in use-sidebar-tab stay the state every component reads; this
 * keeps them and the URL in step in both directions.
 */

const TABS: readonly SidebarTab[] = ["contacts", "chats", "settings"];
const SECTIONS: readonly Exclude<SettingsSubView, null>[] = [
  "profile", "appearance", "callMethods", "notifications", "storage",
  "networking", "desktop", "about", "localAi",
];

export interface SidebarRouteState {
  tab: SidebarTab;
  section: SettingsSubView;
}

const firstValue = (v: LocationQuery[string] | undefined): string | null =>
  (Array.isArray(v) ? v[0] : v) ?? null;

export function parseSidebarQuery(query: LocationQuery): SidebarRouteState {
  const rawTab = firstValue(query.tab);
  const tab = TABS.find((t) => t === rawTab) ?? "chats";
  const rawSection = firstValue(query.section);
  const section = tab === "settings" ? SECTIONS.find((s) => s === rawSection) ?? null : null;
  return { tab, section };
}

/** Route query for the state; keys the sidebar does not own are kept. */
export function buildSidebarQuery(query: LocationQuery, state: SidebarRouteState): LocationQueryRaw {
  const next: LocationQueryRaw = { ...query };
  delete next.tab;
  delete next.section;
  if (state.tab !== "chats") next.tab = state.tab;
  if (state.tab === "settings" && state.section) next.section = state.section;
  return next;
}

/** Chats = 0, a tab = 1, a settings section = 2. Deeper states push a history entry. */
export function sidebarDepth(state: SidebarRouteState): number {
  if (state.tab === "chats") return 0;
  return state.section ? 2 : 1;
}

const sameState = (a: SidebarRouteState, b: SidebarRouteState) =>
  a.tab === b.tab && a.section === b.section;

/** Call once from the page that hosts the sidebar (ChatPage). */
export function useSidebarRouteSync() {
  const route = useRoute();
  const router = useRouter();
  const { activeTab, settingsSubView } = useSidebarTab();

  const current = (): SidebarRouteState => ({ tab: activeTab.value, section: settingsSubView.value });

  // URL → state: initial load, browser Back/Forward, links with a query.
  watch(
    () => route.query,
    (query) => {
      if (route.name !== "ChatPage") return;
      const fromUrl = parseSidebarQuery(query);
      if (sameState(fromUrl, current())) return;
      activeTab.value = fromUrl.tab;
      settingsSubView.value = fromUrl.section;
    },
    { immediate: true },
  );

  // State → URL: taps in the UI and the Android back handlers.
  watch([activeTab, settingsSubView], () => {
    if (route.name !== "ChatPage") return;
    const target = current();
    const fromUrl = parseSidebarQuery(route.query);
    if (sameState(target, fromUrl)) return;

    const location = { name: "ChatPage", query: buildSidebarQuery(route.query, target) };
    if (sidebarDepth(target) > sidebarDepth(fromUrl)) {
      void router.push(location);
      return;
    }
    // Going up: if the previous entry is exactly the target, step back to it
    // so the history does not keep a stale entry behind; otherwise replace.
    const back = router.options.history.state.back;
    if (typeof back === "string" && back === router.resolve(location).fullPath) {
      router.back();
    } else {
      void router.replace(location);
    }
  });
}
