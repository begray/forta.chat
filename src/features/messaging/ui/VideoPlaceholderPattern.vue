<script setup lang="ts">
/**
 * Abstract "film" backdrop behind a video that has no poster yet. Sits on the
 * always-black video frame, so it looks the same in light and dark themes.
 * Color comes from soft CSS radial glows (accent + violet + pink); the SVG on
 * top adds film perforations and flowing light lines. Static: no animation.
 * No SVG gradients/ids, so many bubbles can render it without id clashes.
 */
const HOLES = Array.from({ length: 12 }, (_, i) => 4 + i * 13.5);

const GLOW_STYLE = {
  backgroundImage: [
    "radial-gradient(ellipse 55% 70% at 18% 78%, rgba(var(--color-bg-ac-rgb), 0.38), transparent 70%)",
    "radial-gradient(ellipse 50% 65% at 85% 22%, rgba(139, 92, 246, 0.32), transparent 70%)",
    "radial-gradient(ellipse 40% 50% at 70% 85%, rgba(236, 72, 153, 0.22), transparent 70%)",
    "radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.06), transparent 45%)",
  ].join(", "),
};
</script>

<template>
  <div class="pointer-events-none absolute inset-0" :style="GLOW_STYLE" aria-hidden="true" data-testid="video-placeholder-pattern">
    <svg class="absolute inset-0 h-full w-full text-white" viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" fill="none">
      <!-- film perforations along top and bottom edges -->
      <g fill="currentColor" fill-opacity="0.14">
        <rect v-for="x in HOLES" :key="`t${x}`" :x="x" y="3" width="7" height="4.5" rx="1.2" />
        <rect v-for="x in HOLES" :key="`b${x}`" :x="x" y="82.5" width="7" height="4.5" rx="1.2" />
      </g>
      <!-- flowing light ribbons -->
      <g stroke="currentColor" stroke-linecap="round">
        <path d="M-5 64 C 30 40, 60 80, 95 56 S 150 28, 170 44" stroke-opacity="0.22" stroke-width="0.8" />
        <path d="M-5 70 C 35 48, 65 86, 100 62 S 150 36, 170 52" stroke-opacity="0.14" stroke-width="0.6" />
        <path d="M-5 76 C 40 56, 70 92, 105 68 S 152 44, 170 60" stroke-opacity="0.08" stroke-width="0.5" />
        <path d="M-5 28 C 25 16, 55 42, 90 24 S 145 8, 170 20" stroke-opacity="0.12" stroke-width="0.6" />
      </g>
      <!-- concentric rings around the center button -->
      <g stroke="currentColor" stroke-opacity="0.1" stroke-width="0.5">
        <circle cx="80" cy="45" r="20" />
        <circle cx="80" cy="45" r="28" stroke-opacity="0.06" />
      </g>
      <!-- a few sparkles -->
      <g fill="currentColor">
        <circle cx="28" cy="22" r="0.9" fill-opacity="0.35" />
        <circle cx="134" cy="66" r="0.8" fill-opacity="0.3" />
        <circle cx="118" cy="18" r="0.6" fill-opacity="0.25" />
        <circle cx="46" cy="70" r="0.6" fill-opacity="0.25" />
      </g>
    </svg>
  </div>
</template>
