/**
 * notifier.ts — Telegram push notifications.
 *
 * Configure via environment variables:
 *   TELEGRAM_BOT_TOKEN  — BotFather token (required to enable)
 *   TELEGRAM_CHAT_ID    — target chat/group/channel ID (required to enable)
 *
 * If either variable is missing, all calls are silent no-ops.
 */

import TelegramBot from 'node-telegram-bot-api';
import logger from './logger';

let bot: TelegramBot | null = null;
let chatId: string | null = null;

export function initNotifier(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat  = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    logger.info('[Notifier] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — notifications disabled');
    return;
  }
  bot    = new TelegramBot(token, { polling: false });
  chatId = chat;
  logger.info('[Notifier] Telegram notifications enabled');
}

async function send(text: string): Promise<void> {
  if (!bot || !chatId) return;
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (err) {
    logger.warn('[Notifier] Failed to send Telegram message:', err);
  }
}

export async function notifyFill(params: {
  conditionId: string;
  side: 'BUY' | 'SELL';
  tokenId: string;
  size: number;
  price: number;
  orderId: string;
}): Promise<void> {
  const short = params.conditionId.slice(0, 10);
  const token = params.tokenId.slice(0, 10);
  const msg =
    `🎯 <b>Fill detected</b>\n` +
    `Market: <code>${short}…</code>\n` +
    `Token:  <code>${token}…</code>\n` +
    `Side:   ${params.side}\n` +
    `Price:  ${params.price}\n` +
    `Size:   ${params.size}\n` +
    `Order:  <code>${params.orderId}</code>`;
  await send(msg);
}

export async function notifyClosePlaced(params: {
  conditionId: string;
  tokenId: string;
  size: number;
  closePrice: number;
  fillPrice: number;
  orderId: string;
}): Promise<void> {
  const short = params.conditionId.slice(0, 10);
  const pct = ((params.closePrice / params.fillPrice - 1) * 100).toFixed(1);
  const msg =
    `📤 <b>Close order placed</b>\n` +
    `Market: <code>${short}…</code>\n` +
    `SELL @ ${params.closePrice} (+${pct}% over fill @ ${params.fillPrice})\n` +
    `Size:  ${params.size}\n` +
    `Order: <code>${params.orderId}</code>`;
  await send(msg);
}

export async function notifyCloseComplete(params: {
  conditionId: string;
  reason: string;
}): Promise<void> {
  const short = params.conditionId.slice(0, 10);
  const msg =
    `✅ <b>Position closed</b>\n` +
    `Market: <code>${short}…</code>\n` +
    `Reason: ${params.reason}`;
  await send(msg);
}
