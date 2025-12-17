import fetch from 'node-fetch';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import type { NotificationType, NotificationState } from '../types/index.js';

class TelegramService {
  private state: NotificationState = {
    lastMessages: {},
    lastHeartbeat: 0,
    authFailures: 0,
  };

  async send(message: string): Promise<void> {
    const { botToken, chatId } = config.telegram;

    if (!botToken || !chatId) {
      logger.warn('Telegram credentials not configured. Skipping notification.');
      return;
    }

    try {
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML',
        }),
      });

      if (!response.ok) {
        throw new Error(`Telegram API error: ${response.status}`);
      }

      logger.info('Telegram notification sent successfully');
    } catch (error) {
      logger.error('Failed to send Telegram notification', error as Error);
    }
  }

  async notify(type: NotificationType, message: string, dedupeKey?: string): Promise<void> {
    const now = Date.now();
    const key = dedupeKey || type;

    if (type !== 'heartbeat') {
      const lastSent = this.state.lastMessages[key];
      if (lastSent && now - lastSent < config.notifications.errorInterval) {
        return;
      }
      this.state.lastMessages[key] = now;
    }

    await this.send(message);
  }

  incrementAuthFailures(): void {
    this.state.authFailures++;
  }

  resetAuthFailures(): void {
    this.state.authFailures = 0;
  }

  getAuthFailures(): number {
    return this.state.authFailures;
  }
}

export const telegramService = new TelegramService();

