import { type LocalSessionControlRequestValidated, SessionId } from '@lody/shared';
import { Logger } from '@/utils/logger';
import { EventEmitter } from 'eventemitter3';
import { ConcurrentQueue } from './concurrent-queue';

type QueuedControlMessage = LocalSessionControlRequestValidated;
type MessageQueueKey = string;

export class MessageProcessorStoppedError extends Error {
  constructor() {
    super('Local control message processor is stopping');
    this.name = 'MessageProcessorStoppedError';
  }
}

interface ProcessorEvents {
  'message:processed': (message: QueuedControlMessage) => void;
  'message:error': (error: Error, message: QueuedControlMessage) => void;
  'queue:drained': () => void;
}

/**
 * MessageProcessor - 本地 control 消息的并发处理器
 *
 * 基于 ConcurrentQueue 实现：
 * - 同一个 session 的消息串行处理
 * - 不同 session 的消息并发处理
 */
export class MessageProcessor extends EventEmitter<ProcessorEvents> {
  private readonly queue: ConcurrentQueue<MessageQueueKey>;
  private isStopped = false;
  private readonly pendingDiscards = new Set<() => void>();
  private static readonly QUEUE_WAIT_WARNING_MS = 10_000;
  private static readonly PROCESSING_WARNING_MS = 30_000;

  constructor(
    private readonly logger: Logger,
    maxConcurrentSessions: number = 30
  ) {
    super();
    this.queue = new ConcurrentQueue<MessageQueueKey>(maxConcurrentSessions);
  }

  /**
   * 将消息加入处理队列
   */
  enqueue(
    message: QueuedControlMessage,
    handler: (msg: QueuedControlMessage) => Promise<void>,
    onDiscard?: (error: MessageProcessorStoppedError) => void
  ): void {
    if (this.isStopped) {
      const error = new MessageProcessorStoppedError();
      onDiscard?.(error);
      this.emit('message:error', error, message);
      return;
    }

    const sessionId = this.extractSessionId(message);
    const queueKey = this.extractQueueKey(message);
    const queuedAt = Date.now();
    let started = false;
    const waitWarning = setInterval(() => {
      if (started) {
        return;
      }
      this.logger.warn(
        `Message still waiting in queue type=${message.type} sessionId=${
          sessionId || 'N/A'
        } queuedFor=${Date.now() - queuedAt}ms active=${this.queue.active} waiting=${
          this.queue.waiting
        }`
      );
    }, MessageProcessor.QUEUE_WAIT_WARNING_MS);
    waitWarning.unref?.();
    let discarded = false;
    const discard = () => {
      discarded = true;
      clearInterval(waitWarning);
      const error = new MessageProcessorStoppedError();
      onDiscard?.(error);
      this.emit('message:error', error, message);
    };
    this.pendingDiscards.add(discard);

    this.logger.debug(
      `Enqueued message type=${message.type} sessionId=${sessionId || 'N/A'} active=${
        this.queue.active
      } waiting=${this.queue.waiting}`
    );

    void this.queue.enqueue(queueKey, async () => {
      this.pendingDiscards.delete(discard);
      if (discarded) return;
      const startTime = Date.now();
      started = true;
      clearInterval(waitWarning);
      let processingCompleted = false;
      const processingWarning = setInterval(() => {
        if (processingCompleted) {
          return;
        }
        this.logger.warn(
          `Message still processing type=${message.type} sessionId=${
            sessionId || 'N/A'
          } runningFor=${Date.now() - startTime}ms active=${this.queue.active} waiting=${
            this.queue.waiting
          }`
        );
      }, MessageProcessor.PROCESSING_WARNING_MS);
      processingWarning.unref?.();

      try {
        this.logger.debug(
          `Processing message type=${message.type} sessionId=${
            sessionId || 'N/A'
          } queueWait=${startTime - queuedAt}ms active=${this.queue.active} waiting=${
            this.queue.waiting
          }`
        );

        await handler(message);

        const duration = Date.now() - startTime;
        this.logger.debug(
          `Processed message type=${message.type} sessionId=${sessionId || 'N/A'} duration=${duration}ms`
        );

        this.emit('message:processed', message);
      } catch (error) {
        const duration = Date.now() - startTime;
        const err = error instanceof Error ? error : new Error(String(error));

        this.logger.error(
          `Failed to process message type=${message.type} sessionId=${sessionId || 'N/A'} duration=${duration}ms: ${err.message}`
        );

        this.emit('message:error', err, message);
      } finally {
        processingCompleted = true;
        clearInterval(processingWarning);
      }
    });
  }

  /**
   * 获取当前活跃的 session 数量
   */
  getActiveSessions(): number {
    return this.queue.active;
  }

  /**
   * 获取队列中等待的任务数量
   */
  getQueueSize(): number {
    return this.queue.waiting;
  }

  /**
   * 停止处理新消息
   */
  stop(): void {
    this.isStopped = true;
    // Reject only requests whose handlers have not started. Active handlers may
    // already have committed side effects and must report their actual result.
    const pending = [...this.pendingDiscards];
    this.pendingDiscards.clear();
    for (const discard of pending) discard();
    this.logger.debug('MessageProcessor stopped');
  }

  /**
   * 等待所有活跃任务完成
   */
  async drain(): Promise<void> {
    this.logger.debug(
      `Draining MessageProcessor: active=${this.queue.active} waiting=${this.queue.waiting}`
    );

    await this.queue.drain();
    this.emit('queue:drained');
  }

  /**
   * 等待所有活跃任务完成，带超时
   * @param timeoutMs 超时时间（毫秒）
   */
  async drainWithTimeout(timeoutMs: number): Promise<void> {
    this.logger.debug(
      `Draining MessageProcessor (timeout=${timeoutMs}ms): active=${this.queue.active} waiting=${this.queue.waiting}`
    );

    const completed = await this.queue.drainWithTimeout(timeoutMs);

    if (completed) {
      this.emit('queue:drained');
    } else {
      this.logger.debug(`MessageProcessor drain timed out after ${timeoutMs}ms`);
    }
  }

  /**
   * 从消息中提取 sessionId
   */
  private extractSessionId(message: QueuedControlMessage): SessionId | null {
    switch (message.type) {
      case 'session/create':
      case 'session/chat':
      case 'session/image-upload':
      case 'session/code-collab-host-start':
      case 'session/preview-candidate-report':
      case 'session/preview-create':
      case 'session/preview-revoke':
        return message.sessionId;
      case 'session/cancel':
        return null;
      default:
        return null;
    }
  }

  /**
   * Map messages onto execution lanes.
   *
   * Most session work shares the main lane so create/chat ordering stays intact.
   * Image uploads intentionally use a dedicated lane per session to avoid deadlocking when a
   * running prompt invokes the Lody MCP upload tool and waits for the response.
   */
  private extractQueueKey(message: QueuedControlMessage): MessageQueueKey | null {
    switch (message.type) {
      case 'session/create':
      case 'session/chat':
        return `session:${message.sessionId}:main`;
      case 'session/image-upload':
        return `session:${message.sessionId}:image-upload`;
      case 'session/code-collab-host-start':
        return `session:${message.sessionId}:code-collab`;
      case 'session/preview-candidate-report':
      case 'session/preview-create':
      case 'session/preview-revoke':
        return `session:${message.sessionId}:preview`;
      case 'session/cancel':
        return null;
      default:
        return null;
    }
  }
}
