import crypto from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { memberFromFitness254Webhook, isFitness254WebhookEvent, isMemberWebhookEvent } from './fitness254Webhook.js';
import { syncService } from './sync.js';

const MAX_BODY_BYTES = 1_000_000;
const RECENT_EVENT_LIMIT = 10_000;

export class Fitness254WebhookServer {
  private server: http.Server | null = null;
  private pending = Promise.resolve();
  private readonly recentEventIds = new Set<string>();

  async start(): Promise<void> {
    if (!config.webhook.enabled || this.server) return;
    this.server = http.createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(config.webhook.port, config.webhook.host, () => {
        this.server?.off('error', reject);
        resolve();
      });
    });
    logger.info(`Fitness254 webhook listener ready at ${config.webhook.host}:${config.webhook.port}${config.webhook.path}`);
    if (!config.webhook.secret) {
      logger.warn('Fitness254 webhook listener is accepting unsigned requests; set FITNESS254_WEBHOOK_SECRET before exposing it publicly');
    }
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET' && request.url?.split('?')[0] === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method !== 'POST' || request.url?.split('?')[0] !== config.webhook.path) {
      response.writeHead(404).end();
      return;
    }

    try {
      const rawBody = await this.readBody(request);
      if (!this.hasValidSignature(rawBody, request.headers['x-fitness254-signature'])) {
        response
          .writeHead(401, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: 'Invalid signature' }));
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(rawBody) as unknown;
      } catch {
        response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      if (!isFitness254WebhookEvent(body)) {
        response.writeHead(400).end(JSON.stringify({ error: 'Invalid Fitness254 webhook payload' }));
        return;
      }

      const headerEventId = request.headers['x-fitness254-event-id'];
      const eventId = typeof headerEventId === 'string' ? headerEventId : body.id;
      const duplicate = await this.enqueue(body, eventId);
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(duplicate ? { ok: true, duplicate: true } : { ok: true }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Fitness254 webhook processing failed: ${message}`, error as Error);
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Webhook processing failed' }));
      }
    }
  }

  private enqueue(event: import('../types/index.js').Fitness254WebhookEvent, eventId: string): Promise<boolean> {
    if (this.recentEventIds.has(eventId)) {
      logger.info(`Ignoring duplicate Fitness254 webhook event ${eventId}`);
      return Promise.resolve(true);
    }

    const task = this.pending
      .then(async () => {
        if (event.type === 'webhook.test') {
          logger.info(`webhook.test: ${eventId} received and signature verified`);
          return;
        }
        if (!isMemberWebhookEvent(event)) return;
        const member = memberFromFitness254Webhook(event);
        logger.info(`Processing Fitness254 webhook ${event.type} for turnstile ${member.turnstileId}`);
        await syncService.syncMember(member);
        logger.info(`${event.type}: PIN ${member.turnstileId} processed`);
      })
      .then(() => {
        this.recentEventIds.add(eventId);
        if (this.recentEventIds.size > RECENT_EVENT_LIMIT) this.recentEventIds.clear();
        return false;
      });
    this.pending = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  private hasValidSignature(rawBody: string, signature: string | string[] | undefined): boolean {
    if (!config.webhook.secret || !signature) return false;
    if (Array.isArray(signature)) return false;
    const expected = `sha256=${crypto.createHmac('sha256', config.webhook.secret).update(rawBody).digest('hex')}`;
    const provided = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    return provided.length === expectedBuffer.length && crypto.timingSafeEqual(provided, expectedBuffer);
  }

  private readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          request.destroy();
          reject(new Error('Webhook body exceeds 1 MB limit'));
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      request.on('error', reject);
    });
  }
}

export const fitness254WebhookServer = new Fitness254WebhookServer();
