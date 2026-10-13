// Side effects: defines the skin's UI elements and icons (and <video-skin>).
import "@videojs/html/video/skin";
import { VideoSkinElement } from "@videojs/html/video";

/**
 * `<forta-video-skin>`: the packaged Video.js skin plus our overrides. The
 * skin renders its controls in a shadow root, so page CSS can't reach them —
 * the overrides go into that root as an extra constructed stylesheet. Skin
 * rules sit in a cascade layer behind `:where()`, so these unlayered rules win.
 *
 * Imported only from the lazy Video.js chunk (`loadVideoJs`).
 */
const OVERRIDES = `
/* Narrow player: the top button group (cast / PiP / fullscreen) sits top-left —
   top-right is under the post modal's close button. */
.video-controls-secondary {
  right: auto;
  left: calc(var(--media-spacing) * 2);
}
/* No casting from the app: the button only ever showed disabled. */
.media-cast-button {
  display: none;
}
`;

/**
 * Touch: a tap in the middle of the video plays / pauses (as on mouse); a tap
 * on the sides shows / hides the controls (the skin's touch default for the
 * whole area).
 */
export function retuneTouchGestures(root: ShadowRoot): void {
  const touchTap = root.querySelector('media-gesture[type="tap"][pointer="touch"]');
  if (!touchTap) return;
  touchTap.setAttribute("action", "togglePaused");
  touchTap.setAttribute("region", "center");
  let last: Element = touchTap;
  for (const region of ["left", "right"]) {
    const sideTap = touchTap.cloneNode() as Element;
    sideTap.setAttribute("action", "toggleControls");
    sideTap.setAttribute("region", region);
    last.after(sideTap);
    last = sideTap;
  }
}

export const FORTA_VIDEO_SKIN_TAG = "forta-video-skin";

let overrides: CSSStyleSheet | null = null;

function overridesSheet(): CSSStyleSheet {
  if (!overrides) {
    overrides = new CSSStyleSheet();
    overrides.replaceSync(OVERRIDES);
  }
  return overrides;
}

export class FortaVideoSkinElement extends VideoSkinElement {
  constructor() {
    super();
    const root = this.shadowRoot;
    if (!root) return;
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, overridesSheet()];
    retuneTouchGestures(root);
  }
}

if (!customElements.get(FORTA_VIDEO_SKIN_TAG)) {
  customElements.define(FORTA_VIDEO_SKIN_TAG, FortaVideoSkinElement);
}
