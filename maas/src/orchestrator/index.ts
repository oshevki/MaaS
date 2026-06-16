import { Client } from 'pg';
import { getDatabaseSslConfig, pool } from '../../../shared/db';
import { logger } from '../../../shared/logger';
import { runAnalyzer, runAssembler, runFinalResponder, runArchivist } from '../agents';

/**
 * Pipeline Event from NOTIFY
 */
interface PipelineEvent {
  id: string;
  status: string;
  operation: string;
}

/**
 * Retry configuration
 */
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute with retry logic
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  pipelineId: string
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < RETRY_CONFIG.maxRetries) {
        const delay = Math.min(
          RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt - 1),
          RETRY_CONFIG.maxDelayMs
        );
        logger.warn(`[Orchestrator] ${operationName} failed (attempt ${attempt}/${RETRY_CONFIG.maxRetries}), retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  logger.error(`[Orchestrator] ${operationName} failed after ${RETRY_CONFIG.maxRetries} attempts for ${pipelineId}`);
  throw lastError;
}

/**
 * Orchestrator - Event-Driven Coordinator
 *
 * Слушает PostgreSQL NOTIFY события и маршрутизирует задачи к агентам.
 * Использует Blackboard Pattern - модули взаимодействуют через БД.
 */
export class Orchestrator {
  private client: Client | null = null;
  private isRunning: boolean = false;
  private inFlightTasks = new Set<Promise<void>>();

  /**
   * Запустить Orchestrator
   */
  async start() {
    try {
      // Создаём отдельный Client для LISTEN (не PoolClient)
      this.client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: getDatabaseSslConfig(),
      });
      await this.client.connect();
      this.isRunning = true;

      // Подписка на события pipeline_events
      await this.client.query('LISTEN pipeline_events');
      logger.info('📡 [Orchestrator] Listening for pipeline events...');

      // Обработчик уведомлений
      this.client.on('notification', (msg) => {
        if (!msg.payload) return;

        try {
          const event: PipelineEvent = JSON.parse(msg.payload);
          logger.info('🔔 [Orchestrator] Event received:', event);

          this.trackTask(
            this.handleEvent(event).catch((error) => {
              logger.error('[Orchestrator] Error handling notification:', error);
            })
          );
        } catch (error) {
          logger.error('[Orchestrator] Error parsing notification:', error);
        }
      });

      // Обработчик ошибок подключения
      this.client.on('error', (err) => {
        logger.error('❌ [Orchestrator] DB connection error:', err);
        this.reconnect();
      });

      // Обработчик закрытия подключения
      this.client.on('end', () => {
        if (this.isRunning) {
          logger.warn('⚠️  [Orchestrator] Connection closed unexpectedly');
          this.reconnect();
        }
      });

      logger.info('✅ [Orchestrator] Started successfully');
    } catch (error) {
      logger.error('❌ [Orchestrator] Failed to start:', error);
      throw error;
    }
  }

  /**
   * Track async notification handlers so graceful shutdown can wait for them.
   */
  private trackTask(task: Promise<void>) {
    this.inFlightTasks.add(task);
    task.finally(() => {
      this.inFlightTasks.delete(task);
    });
  }

  /**
   * Маршрутизация событий к агентам с retry логикой
   */
  private async handleEvent(event: PipelineEvent) {
    const { id, status } = event;

    try {
      switch (status) {
        case 'NEW':
          logger.info(`➡️  [Orchestrator] Routing to Analyzer: ${id}`);
          await withRetry(() => runAnalyzer(id), 'Analyzer', id);
          break;

        case 'ANALYZED':
          logger.info(`➡️  [Orchestrator] Routing to Assembler: ${id}`);
          await withRetry(() => runAssembler(id), 'Assembler', id);
          break;

        case 'READY':
          logger.info(`➡️  [Orchestrator] Routing to FinalResponder: ${id}`);
          await withRetry(() => runFinalResponder(id), 'FinalResponder', id);
          break;

        case 'COMPLETED':
          logger.info(`✅ [Orchestrator] Request completed: ${id}`);
          // Запускаем Archivist для создания долгосрочной памяти (без retry - не критично)
          logger.info(`➡️  [Orchestrator] Routing to Archivist: ${id}`);
          try {
            await runArchivist(id);
          } catch (archivistError) {
            // Archivist failure is non-critical - log but don't fail the pipeline
            logger.warn(`[Orchestrator] Archivist failed for ${id}, but pipeline completed:`, archivistError);
          }
          break;

        case 'FAILED':
          logger.error(`❌ [Orchestrator] Request failed: ${id}`);
          break;

        case 'ANALYZING':
        case 'ASSEMBLING':
        case 'RESPONDING':
          // Промежуточные статусы - игнорируем (не требуют действий)
          logger.debug(`⏭️  [Orchestrator] Intermediate status: ${status} for ${id}`);
          break;

        default:
          logger.warn(`⚠️  [Orchestrator] Unknown status: ${status} for ${id}`);
      }
    } catch (error) {
      logger.error(`[Orchestrator] Error handling event for ${id}:`, error);

      // Попытка пометить задачу как Failed
      try {
        await this.markAsFailed(id, error);
      } catch (markError) {
        logger.error(`[Orchestrator] Failed to mark ${id} as FAILED:`, markError);
      }
    }
  }

  /**
   * Пометить pipeline_run как FAILED
   */
  private async markAsFailed(id: string, error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Используем pool для запросов UPDATE (client занят LISTEN)
    try {
      await pool.query(
        `UPDATE pipeline_runs
         SET status = 'FAILED',
             error_message = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [errorMessage, id]
      );
      logger.info(`[Orchestrator] Marked ${id} as FAILED`);
    } catch (err) {
      logger.error('[Orchestrator] Failed to mark as FAILED:', err);
    }
  }

  /**
   * Переподключение при потере соединения
   */
  private async reconnect() {
    if (!this.isRunning) return;

    logger.info('🔄 [Orchestrator] Attempting to reconnect in 5 seconds...');

    // Закрыть старое подключение
    if (this.client) {
      try {
        this.client.removeAllListeners();
        await this.client.end();
      } catch (error) {
        logger.error('[Orchestrator] Error closing old connection:', error);
      }
      this.client = null;
    }

    // Переподключиться через 5 секунд
    setTimeout(async () => {
      try {
        await this.start();
      } catch (error) {
        logger.error('[Orchestrator] Reconnection failed:', error);
        this.reconnect(); // Попробовать снова
      }
    }, 5000);
  }

  /**
   * Остановить Orchestrator
   */
  async stop() {
    this.isRunning = false;

    if (this.client) {
      try {
        await this.client.query('UNLISTEN pipeline_events');
        this.client.removeAllListeners();

        const pendingTasks = Array.from(this.inFlightTasks);
        if (pendingTasks.length > 0) {
          logger.info(`[Orchestrator] Waiting for ${pendingTasks.length} in-flight task(s)...`);
          await Promise.allSettled(pendingTasks);
        }

        await this.client.end();
        logger.info('👋 [Orchestrator] Stopped');
      } catch (error) {
        logger.error('[Orchestrator] Error during shutdown:', error);
      }
      this.client = null;
    }
  }

  /**
   * Проверка состояния
   */
  isActive(): boolean {
    return this.isRunning && this.client !== null;
  }
}
