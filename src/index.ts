import cron from 'node-cron';
import { config, validateConfig } from './config/index.js';
import { logger } from './utils/logger.js';
import { telegramService } from './services/telegram.js';
import { syncService } from './services/sync.js';
import { formatUptime } from './utils/helpers.js';

async function sendHeartbeat(): Promise<void> {
  const now = new Date();
  const uptime = process.uptime();
  const uptimeFormatted = formatUptime(uptime);

  const message = `
<b>${config.gym.name} - Daily Heartbeat</b>

<b>Date:</b> ${now.toLocaleDateString()}
<b>Time:</b> ${now.toLocaleTimeString()}
<b>Uptime:</b> ${uptimeFormatted}
<b>Status:</b> Running normally
<b>Auth Failures:</b> ${telegramService.getAuthFailures()}
  `.trim();

  await telegramService.notify('heartbeat', message);
  logger.info('Daily heartbeat sent');
}

function setupHeartbeat(): void {
  cron.schedule(
    config.notifications.heartbeatSchedule,
    async () => {
      logger.info('Sending daily heartbeat...');
      await sendHeartbeat();
    },
    {
      timezone: config.notifications.heartbeatTimezone,
    }
  );
}

function setupGracefulShutdown(): void {
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Graceful shutdown...`);
    await telegramService.notify(
      'shutdown',
      `<b>System Shutdown</b>\n\n` +
        `<b>Signal:</b> ${signal}\n` +
        `<b>Time:</b> ${new Date().toLocaleString()}\n` +
        `<b>Uptime:</b> ${formatUptime(process.uptime())}\n\n` +
        `Service stopped ${signal === 'SIGINT' ? 'manually' : 'by system'}.`
    );
    logger.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', async (error) => {
    logger.error('Uncaught Exception', error);

    await telegramService.notify(
      'fatal_error',
      `<b>Fatal Error - System Crashed</b>\n\n` +
        `<b>Error:</b> ${error.message}\n` +
        `<b>Stack:</b> ${error.stack?.split('\n')[1] || 'Unknown'}\n` +
        `<b>Time:</b> ${new Date().toLocaleString()}\n\n` +
        `System will attempt to restart...`
    );

    setTimeout(() => {
      logger.close();
      process.exit(1);
    }, 3000);
  });

  process.on('unhandledRejection', async (reason) => {
    logger.error('Unhandled Rejection', reason as Error);

    await telegramService.notify(
      'unhandled_error',
      `<b>Unhandled Promise Rejection</b>\n\n` +
        `<b>Reason:</b> ${reason}\n` +
        `<b>Time:</b> ${new Date().toLocaleString()}\n\n` +
        `System continues running but may be unstable.`,
      'unhandled_rejection'
    );
  });
}

async function main(): Promise<void> {
  try {
    logger.info(`Starting ${config.gym.name} integration with ${config.accessControl.vendor}...`);

    validateConfig();

    if (config.accessControl.vendor === 'zkbio') {
      logger.info(`Connecting to ZKBioCVSecurity at: ${config.zkbio.baseUrl}`);
    } else if (config.accessControl.vendor === 'hikvision') {
      logger.info(`Connecting to Hikvision HikCentral at: ${config.hikvision.baseUrl}`);
    }

    await telegramService.notify(
      'startup',
      `<b>${config.gym.name} - Started</b>\n\n` +
        (config.accessControl.vendor === 'zkbio'
          ? `<b>ZKBio Server:</b> ${config.zkbio.baseUrl}\n`
          : `<b>HikCentral Server:</b> ${config.hikvision.baseUrl}\n`) +
        `<b>Gym API:</b> ${config.gym.apiUrl}\n` +
        `<b>Start Time:</b> ${new Date().toLocaleString()}\n` +
        `<b>Sync Interval:</b> Every ${config.sync.interval / 1000} seconds\n` +
        `<b>Heartbeat:</b> Daily at ${config.notifications.heartbeatSchedule}\n` +
        `<b>Performance:</b> Batch processing (${config.sync.batchSize} per batch)\n\n` +
        `System initialized with optimized batch processing for faster syncs.`
    );

    setupHeartbeat();
    setupGracefulShutdown();

    logger.info('Performing initial data sync...');
    await syncService.sync();

    setInterval(async () => {
      try {
        logger.info('Running periodic sync...');
        await syncService.sync();
      } catch (error) {
        logger.error('Periodic sync error', error as Error);
      }
    }, config.sync.interval);

    logger.info(
      `${config.gym.name} integration started successfully. Running periodic sync every ${config.sync.interval / 1000} seconds...`
    );
  } catch (error) {
    logger.error('Failed to start application', error as Error);

    await telegramService.notify(
      'startup_failed',
      `<b>Startup Failed</b>\n\n` +
        `<b>Error:</b> ${(error as Error).message}\n` +
        `<b>Time:</b> ${new Date().toLocaleString()}\n\n` +
        `Service failed to start - check configuration`
    );

    logger.close();
    process.exit(1);
  }
}

main();

