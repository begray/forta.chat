<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import { DeleteAccountError, type DeleteAccountErrorCode, type DeleteAccountStep } from "@/entities/auth/lib/delete-account";
import { useToast } from "@/shared/lib/use-toast";
import type { TranslationKey } from "@/shared/lib/i18n";

// Account deletion, with Pocketnet's dialog, step messages and error texts
// (pocketnet components/usersettings, removeAccount).
const router = useRouter();
const authStore = useAuthStore();
const { t } = useI18n();
const { toast } = useToast();

const showConfirm = ref(false);
const step = ref<DeleteAccountStep | null>(null);
const errorKey = ref<TranslationKey | null>(null);

const STEP_KEYS: Record<DeleteAccountStep, TranslationKey> = {
  prepare: "settings.deleteAccount.step.prepare",
  removePeertube: "settings.deleteAccount.step.removePeertube",
  removeMatrix: "settings.deleteAccount.step.removeMatrix",
  removeBB: "settings.deleteAccount.step.removeBB",
};

const ERROR_KEYS: Record<DeleteAccountErrorCode, TranslationKey> = {
  notprepared: "settings.deleteAccount.error.notprepared",
  balance: "settings.deleteAccount.error.balance",
  undefinedError: "settings.deleteAccount.error.undefinedError",
};

const handleConfirm = async () => {
  showConfirm.value = false;
  errorKey.value = null;
  step.value = "prepare";
  try {
    await authStore.deleteAccount((s) => { step.value = s; });
    step.value = null;
    toast(t("settings.deleteAccount.success"), "success", 8000);
    await router.replace({ name: "WelcomePage" });
  } catch (e) {
    console.error("[DeleteAccount] failed:", e);
    const code = e instanceof DeleteAccountError ? e.code : "undefinedError";
    errorKey.value = ERROR_KEYS[code];
    step.value = null;
  }
};
</script>

<template>
  <button
    type="button"
    class="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-color-bad transition-colors hover:bg-neutral-grad-0"
    @click="showConfirm = true"
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
    <span class="flex-1 text-left text-sm">{{ t("settings.deleteAccount.button") }}</span>
  </button>

  <Teleport to="body">
    <div
      v-if="showConfirm"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="delete-account-confirm"
      @click.self="showConfirm = false"
    >
      <div class="mx-4 max-w-sm rounded-xl bg-background-secondary-theme p-6 shadow-xl">
        <p class="mb-4 text-sm text-text-color">{{ t("settings.deleteAccount.question") }}</p>
        <div class="flex flex-wrap justify-end gap-3">
          <button
            type="button"
            class="rounded-lg px-4 py-2 text-sm text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
            data-testid="delete-account-cancel"
            @click="showConfirm = false"
          >
            {{ t("common.cancel") }}
          </button>
          <button
            type="button"
            class="rounded-lg bg-color-bad px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-80"
            data-testid="delete-account-yes"
            @click="handleConfirm"
          >
            {{ t("settings.deleteAccount.yes") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Deletion in progress: not dismissible, a half-run deletion must not be abandoned from here. -->
    <div
      v-if="step"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      data-testid="delete-account-progress"
    >
      <div class="mx-4 flex max-w-sm items-center gap-3 rounded-xl bg-background-secondary-theme p-6 shadow-xl">
        <div class="contain-strict h-6 w-6 shrink-0 animate-spin rounded-full border-2 border-color-bg-ac border-t-transparent" />
        <p class="text-sm text-text-color">{{ t(STEP_KEYS[step]) }}</p>
      </div>
    </div>

    <div
      v-if="errorKey"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="delete-account-error"
      @click.self="errorKey = null"
    >
      <div class="mx-4 max-w-sm rounded-xl bg-background-secondary-theme p-6 shadow-xl">
        <p class="mb-4 text-sm text-text-color">{{ t(errorKey) }}</p>
        <div class="flex justify-end">
          <button
            type="button"
            class="rounded-lg bg-color-bg-ac px-4 py-2 text-sm font-medium text-text-on-bg-ac-color"
            @click="errorKey = null"
          >
            {{ t("settings.deleteAccount.ok") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
