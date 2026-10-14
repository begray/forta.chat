import { setupProviders } from "@/app/providers";
import { AppLoading } from "@/app/ui/app-loading";
import { bootStatus } from "@/app/model/boot-status";
import { revealApp } from "@/app/model/reveal-app";
import { createApp, type App } from "vue";

import AppComponent from "./App.vue";

const BOOT_TIMEOUT_MS = 60_000;

let loadingApp: App | null = null;

async function setupApp(): Promise<App | null> {
  loadingApp = createApp(AppLoading);
  loadingApp.mount("#appLoading");
  const app = createApp(AppComponent);

  app.config.errorHandler = (err, _instance, info) => {
    console.error('[Vue Error]', err, info);
  };

  window.addEventListener('unhandledrejection', (e) => {
    console.error('[Unhandled Promise]', e.reason);
    if (bootStatus.state.value === 'booting') {
      bootStatus.setError(String(e.reason));
    }
  });

  // Global boot timeout — ensure loader never spins forever
  const bootTimer = setTimeout(() => {
    if (bootStatus.state.value === "booting") {
      bootStatus.setError(
        `Boot timed out after ${BOOT_TIMEOUT_MS / 1000}s at step: ${bootStatus.currentStep.value}`,
      );
    }
  }, BOOT_TIMEOUT_MS);

  try {
    await setupProviders(app);
    clearTimeout(bootTimer);
    bootStatus.setReady();
    return app;
  } catch (e) {
    clearTimeout(bootTimer);
    console.error("[BOOT] setupProviders failed:", e);
    bootStatus.setError(String(e instanceof Error ? e.message : e));
    // Return null — AppLoading stays mounted and shows error UI
    return null;
  }
}

export const app = setupApp();

/** Mount the booted app; the boot loader stays over it briefly (see revealApp). */
export function mountApp(booted: App): void {
  if (loadingApp) revealApp(booted, loadingApp);
  else booted.mount("#app");
}
