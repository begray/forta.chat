import type { TranslationKey } from "@/shared/lib/i18n";
import { formatFileMegabytes, formatLimitMegabytes } from "@/shared/lib/file-transfer/upload-limit";
import { sendErrorI18nKey, type SendErrorContext, type SendErrorKind } from "./send-errors";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/** The send banner's text for an error, with sizes and counts filled in. */
export function sendErrorLabel(error: { kind: SendErrorKind; context: SendErrorContext }, t: Translate): string {
  const ctx = error.context;
  if (error.kind === "fileTooLarge" && ctx.sizeBytes && ctx.limitBytes) {
    const params = { size: formatFileMegabytes(ctx.sizeBytes), limit: formatLimitMegabytes(ctx.limitBytes) };
    if (ctx.kind === "video" && ctx.compressFailure) return t("errors.send.videoNotCompressedSized", params);
    return ctx.kind === "video" ? t("errors.send.videoTooLargeSized", params) : t("errors.send.fileTooLargeSized", params);
  }
  if (error.kind === "videoTooLong" && ctx.maxDurationMs) {
    return t("errors.send.videoTooLongSized", { minutes: String(Math.floor(ctx.maxDurationMs / 60_000)) });
  }
  if (error.kind === "batchIncomplete" && ctx.totalCount && ctx.failedCount) {
    const counts = { failed: ctx.failedCount, total: ctx.totalCount };
    const unreadable = ctx.unreadableCount ?? 0;
    if (unreadable >= ctx.failedCount) return t("errors.send.batchUnreadable", counts);
    const parts = [t("errors.send.batchIncomplete", counts)];
    if (unreadable > 0) parts.push(t("errors.send.batchUnreadablePart", { count: unreadable }));
    if (ctx.detail && ctx.detail.kind !== "batchIncomplete") parts.push(sendErrorLabel(ctx.detail, t));
    return parts.join(" ");
  }
  // Every SendErrorKind has an `errors.send.<kind>` key in en.ts.
  return t(sendErrorI18nKey(error.kind) as TranslationKey);
}
