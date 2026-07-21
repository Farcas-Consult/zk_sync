# ZK Sync Service

A TypeScript-based synchronization service that integrates gym management systems with ZKBioCVSecurity access control system. Supports multiple gyms through environment-based configuration.

## Features

- **Batch Processing**: Efficiently syncs large numbers of members using batch operations
- **Webhook-first sync**: Fitness254 member events update only the affected member
- **Reconciliation sync**: An hourly full sync catches missed events and manual changes
- **Telegram Notifications**: Optional Telegram bot integration for alerts and heartbeats
- **Error Handling**: Comprehensive error handling with graceful degradation
- **Type Safety**: Full TypeScript implementation with strict type checking

## Prerequisites

- Node.js >= 18.0.0
- pnpm (package manager)

## Installation

1. Install dependencies:
```bash
pnpm install
```

2. Copy the example environment file:
```bash
cp .env.example .env
```

3. Configure your environment variables in `.env`:

   **Required Variables:**
   - `BIOCV_BASE_URL`: ZKBioCVSecurity server URL
   - `BIOCV_ACCESS_TOKEN`: Access token for ZKBioCVSecurity API
   - `ZKBIO_ACCESS_LEVEL_ID`: Access level ID for gym members in ZKBio
   - `GMS_API_URL`: Gym management system API URL
   - `GMS_API_KEY`: API key for gym management system

   **Optional Variables:**
   - `ZKBIO_DEPT_CODE`: Department code in ZKBio (default: `1`)
   - `GYM_NAME`: Name of the gym (for notifications, default: `Gym`)
   - `GYM_EMAIL_DOMAIN`: Email domain for generated emails (default: `gym.local`)
   - `TELEGRAM_BOT_TOKEN`: Telegram bot token for notifications
   - `TELEGRAM_CHAT_ID`: Telegram chat ID for notifications
   - `WEBHOOK_PORT`: local listener port (default: `4000`)
   - `FITNESS254_WEBHOOK_PATH`: listener path (default: `/fitness254/webhook`)
   - `FITNESS254_WEBHOOK_SECRET`: required signing secret; HMAC-SHA256 is verified from `x-fitness254-signature`
   - `SYNC_INTERVAL_MS`: reconciliation interval (default: `3600000` = 1 hour)
   - `SYNC_BATCH_SIZE`: Number of persons per batch (default: `300`)
   - `SYNC_BATCH_DELAY_MS`: Delay between batches in ms (default: `100`)
   - `SYNC_OPERATION_DELAY_MS`: Delay between operations in ms (default: `100`)
   - `HEARTBEAT_SCHEDULE`: Cron schedule for heartbeat (default: `30 20 * * *` = 20:30 daily)
   - `HEARTBEAT_TIMEZONE`: Timezone for heartbeat schedule (default: `Africa/Nairobi`)

## Usage

### Development

Run in development mode with hot reload:
```bash
pnpm dev
```

### Production

Build the project:
```bash
pnpm build
```

Run the compiled code:
```bash
pnpm start
```

### Fitness254 webhooks

Expose `http(s)://<host>:4000/fitness254/webhook` (or your configured port and path), then register it as the Fitness254 workflow destination for `member.*` events and `webhook.test`. The service verifies the HMAC-SHA256 signature from `x-fitness254-signature` against the exact raw body, serializes the update with reconciliation work, and returns success only after processing. `GET /health` returns `{ "ok": true }` for tunnel monitoring.

## Project Structure

```
zk_sync/
├── src/
│   ├── config/          # Configuration and environment variables
│   ├── services/        # Business logic services
│   │   ├── telegram.ts  # Telegram notification service
│   │   ├── zkbio.ts     # ZKBio API client
│   │   └── sync.ts       # Main sync service
│   ├── types/           # TypeScript type definitions
│   ├── utils/           # Utility functions
│   │   ├── logger.ts    # Logging utility
│   │   └── helpers.ts   # Helper functions
│   └── index.ts         # Application entry point
├── dist/                # Compiled JavaScript (generated)
├── package.json
├── tsconfig.json
└── README.md
```

## Configuration

The service can be configured via environment variables. See `.env.example` for all available options.

### Sync Settings

All sync settings are configurable via environment variables:
- **Reconciliation Interval**: Default 1 hour (configurable via `SYNC_INTERVAL_MS`); Fitness254 webhooks handle regular changes immediately.
- **Batch Size**: Default 300 persons per batch (configurable via `SYNC_BATCH_SIZE`)
- **Heartbeat**: Default daily at 20:30 (configurable via `HEARTBEAT_SCHEDULE` and `HEARTBEAT_TIMEZONE`)

### Multi-Gym Support

The service supports multiple gyms through environment-based configuration. Each gym can have:
- Different ZKBio access level IDs (`ZKBIO_ACCESS_LEVEL_ID`)
- Different department codes (`ZKBIO_DEPT_CODE`)
- Custom gym name (`GYM_NAME`) for notifications
- Custom email domain (`GYM_EMAIL_DOMAIN`)
- Custom sync intervals and batch sizes

## Features

### Batch Processing

The service uses efficient batch processing to fetch and sync large numbers of members, reducing API calls and improving performance.

### Error Handling

- Automatic retry logic for transient failures
- Telegram notifications for critical errors
- Graceful shutdown handling
- Comprehensive logging

### Monitoring

- Daily heartbeat notifications via Telegram
- Error notifications with deduplication
- Detailed logging to both console and log file

## License

ISC
