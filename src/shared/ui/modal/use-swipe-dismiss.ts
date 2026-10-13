import { ref } from "vue";

/** Movement before the gesture picks a direction; below it a tap stays a tap. */
const DIRECTION_SLOP_PX = 8;
/** Dragged past this share of the sheet height, release closes it. */
const DISMISS_DISTANCE_RATIO = 0.25;
/** A quick flick closes the sheet even when it moved less than the ratio above. */
const DISMISS_VELOCITY_PX_PER_MS = 0.5;
const MIN_FLICK_DISTANCE_PX = 30;

interface Options {
  /** Read at touchstart: false keeps the sheet still (desktop layout). */
  isEnabled: () => boolean;
  /** The sheet's scrolling body: a pull starting there drags only from its top. */
  getScrollEl: () => HTMLElement | undefined;
  getSheetEl: () => HTMLElement | undefined;
  onDismiss: () => void;
}

/**
 * Drag a bottom sheet down to close it. The gesture locks to a direction on
 * the first few pixels: a downward pull drags the sheet, anything else (a
 * horizontal seek on a video, an upward scroll) is left to the content.
 */
export function useSwipeDismiss(options: Options) {
  const offset = ref(0);
  const dragging = ref(false);
  let tracking = false;
  let startX = 0;
  let startY = 0;
  let startTime = 0;

  const onTouchStart = (e: TouchEvent) => {
    if (!options.isEnabled() || e.touches.length !== 1) return;
    const scrollEl = options.getScrollEl();
    const target = e.target as Node | null;
    // A finger on content scrolled away from its top scrolls the content.
    if (target && scrollEl?.contains(target) && scrollEl.scrollTop > 0) return;
    tracking = true;
    dragging.value = false;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startTime = Date.now();
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!tracking) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (!dragging.value) {
      if (Math.abs(dx) < DIRECTION_SLOP_PX && Math.abs(dy) < DIRECTION_SLOP_PX) return;
      if (dy <= 0 || Math.abs(dx) >= dy) {
        tracking = false;
        return;
      }
      dragging.value = true;
    }
    // Keep the content and the page (pull-to-refresh) from moving under the finger.
    if (e.cancelable) e.preventDefault();
    offset.value = Math.max(0, dy);
  };

  const onTouchEnd = () => {
    const wasDragging = dragging.value;
    tracking = false;
    dragging.value = false;
    if (!wasDragging) return;
    const height = options.getSheetEl()?.offsetHeight || 300;
    const velocity = offset.value / Math.max(1, Date.now() - startTime);
    const isFlick = velocity > DISMISS_VELOCITY_PX_PER_MS && offset.value > MIN_FLICK_DISTANCE_PX;
    if (offset.value > height * DISMISS_DISTANCE_RATIO || isFlick) {
      // Keep the offset: the leave transition slides out from where the finger let go.
      options.onDismiss();
    } else {
      offset.value = 0;
    }
  };

  /** The system took the touch (a gesture, the notification shade): snap back. */
  const onTouchCancel = () => {
    tracking = false;
    dragging.value = false;
    offset.value = 0;
  };

  const reset = () => {
    tracking = false;
    dragging.value = false;
    offset.value = 0;
  };

  return { offset, dragging, onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, reset };
}
