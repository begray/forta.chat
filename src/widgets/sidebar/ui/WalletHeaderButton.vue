<script setup lang="ts">
import { ref, watch } from "vue";
import { formatPkoin } from "@/features/wallet";

const props = defineProps<{ balance: number | null; isLoading: boolean; hasError: boolean }>();
const emit = defineEmits<{ refresh: [] }>();
const { t } = useI18n();

// The logo spins while the balance loads; the last known balance stays in
// place so the button keeps its width. When loading ends the current turn
// finishes first, so the logo always stops upright instead of snapping back.
// A failed request turns the logo red until the next successful refresh.
const isSpinning = ref(props.isLoading);
watch(
  () => props.isLoading,
  (loading) => {
    if (loading) isSpinning.value = true;
  },
);
const handleSpinIteration = () => {
  if (!props.isLoading) isSpinning.value = false;
};
</script>

<template>
  <button
    class="btn-press flex h-9 items-center gap-1.5 rounded-full bg-neutral-grad-0 px-2.5 text-text-color transition-colors hover:bg-neutral-grad-2/30"
    :title="t('settings.wallet')"
    :aria-busy="props.isLoading"
    @click="emit('refresh')"
  >
    <span
      class="contain-strict block h-4 w-4 shrink-0 transition-colors"
      :class="[isSpinning && 'animate-spin', props.hasError ? 'text-color-bad' : 'text-color-txt-ac']"
      data-testid="wallet-logo"
      @animationiteration="handleSpinIteration"
    >
      <svg width="16" height="16" viewBox="0 0 18 18" fill="currentColor" class="block">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M17.2584 1.97869L15.182 0L12.7245 2.57886C11.5308 1.85218 10.1288 1.43362 8.62907 1.43362C7.32722 1.43362 6.09904 1.74902 5.01676 2.30756L2.81787 6.45386e-05L0.741455 1.97875L2.73903 4.07498C1.49651 5.46899 0.741455 7.30694 0.741455 9.32124C0.741455 11.1753 1.38114 12.8799 2.45184 14.2264L0.741455 16.0213L2.81787 18L4.61598 16.1131C5.79166 16.8092 7.1637 17.2088 8.62907 17.2088C10.2903 17.2088 11.8317 16.6953 13.1029 15.8182L15.182 18L17.2584 16.0213L15.1306 13.7884C16.0049 12.5184 16.5167 10.9796 16.5167 9.32124C16.5167 7.50123 15.9003 5.8252 14.8648 4.49052L17.2584 1.97869ZM3.5551 9.32124C3.5551 12.1235 5.82679 14.3952 8.62907 14.3952C11.4313 14.3952 13.703 12.1235 13.703 9.32124C13.703 6.51896 11.4313 4.24727 8.62907 4.24727C5.82679 4.24727 3.5551 6.51896 3.5551 9.32124Z" />
      </svg>
    </span>
    <span
      v-if="props.balance !== null"
      class="text-xs font-semibold tabular-nums text-color-txt-ac"
    >{{ formatPkoin(props.balance) }}</span>
  </button>
</template>
