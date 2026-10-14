/**
 * Detects messages that consist only of emoji, so the chat can render them
 * large and without a bubble background (Telegram-style "jumbo" emoji).
 *
 * Regex-based instead of Intl.Segmenter: Segmenter is missing on the old
 * Android WebViews (API 24) and iOS 15 WKWebView we still support.
 */

/** One emoji "glyph": flag pair, keycap, or pictograph with optional
 *  variation selector / skin tone / tag sequence / ZWJ joins. */
const EMOJI_SEQUENCE =
  /[\u{1F1E6}-\u{1F1FF}]{2}|[#*0-9]️?⃣|\p{Extended_Pictographic}[️\u{1F3FB}-\u{1F3FF}]*[\u{E0020}-\u{E007F}]*(?:‍\p{Extended_Pictographic}[️\u{1F3FB}-\u{1F3FF}]*)*/gu;

/** Max emoji count still rendered as jumbo ("fewer than 7"). */
export const JUMBO_EMOJI_MAX = 6;

/**
 * Number of emoji when `text` is made only of emoji (whitespace allowed),
 * otherwise 0.
 */
export function countEmojiOnly(text: string | null | undefined): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  let count = 0;
  const rest = trimmed.replace(EMOJI_SEQUENCE, () => {
    count++;
    return "";
  });
  return rest.replace(/\s+/g, "") === "" ? count : 0;
}

/** True when `text` is 1..JUMBO_EMOJI_MAX emoji and nothing else. */
export function isJumboEmoji(text: string | null | undefined): boolean {
  const n = countEmojiOnly(text);
  return n > 0 && n <= JUMBO_EMOJI_MAX;
}
