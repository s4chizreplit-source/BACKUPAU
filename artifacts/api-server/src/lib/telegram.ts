import { logger } from "./logger";

const TELEGRAM_TIMEOUT_MS = 8_000;

function configuredChatIds(): string[] {
  return [
    process.env.TELEGRAM_ADMIN_CHAT_ID_1,
    process.env.TELEGRAM_ADMIN_CHAT_ID_2,
  ].filter((value): value is string => Boolean(value?.trim()));
}

/**
 * Sends an operational notification to every configured admin chat.
 * Notification delivery is best-effort and never throws into payment flows.
 */
export async function notifyTelegramAdmins(lines: Array<string | null | undefined>): Promise<void> {
  if (process.env.NODE_ENV === "test") return;

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatIds = configuredChatIds();
  if (!token || chatIds.length === 0) {
    logger.warn("Telegram admin notifications are not fully configured");
    return;
  }

  const text = lines.filter((line): line is string => Boolean(line)).join("\n");
  const results = await Promise.allSettled(chatIds.map(async (chatId, index) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        logger.warn({ status: response.status, adminChat: index + 1 }, "Telegram notification rejected");
        return false;
      }
      return true;
    } catch (err) {
      logger.warn({ err, adminChat: index + 1 }, "Telegram notification failed");
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }));

  const delivered = results.filter(result => result.status === "fulfilled" && result.value).length;
  logger.info({ delivered, configured: chatIds.length }, "Telegram admin notification processed");
}