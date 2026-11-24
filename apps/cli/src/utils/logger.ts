import { EventEmitter } from 'node:events';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { formatLogArgs } from './log-format';
import { getDesktopBuildDescription } from './desktop-build';
import { cleanupExpiredLogs, LODY_LOG_DIR, LODY_LOG_RETENTION_MAX_FILES } from './log-retention';
import {
  type FileLogSink,
  probeDirectoryWritable,
  ResilientFileTransport,
  type ResilientFileTransportOptions,
} from './resilient-file-transport';

const cleanedLogDirs = new Set<string>();

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
} as const;

const TRACE_ENV_VAR = 'LODY_LOG_TRACE';

const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);

/** Whether `trace` records should reach the file sink. Opt-in, off by default. */
export const isTraceLoggingEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  TRUTHY_ENV_VALUES.has((env[TRACE_ENV_VAR] ?? '').trim().toLowerCase());

/**
 * The file transport ignores the console level: it is the diagnostic sink and
 * always captures `debug`. It only descends to `trace` when explicitly enabled.
 */
export const resolveFileLogLevel = (env: NodeJS.ProcessEnv = process.env): 'debug' | 'trace' =>
  isTraceLoggingEnabled(env) ? 'trace' : 'debug';

const createConsoleFormatter = () => {
  return winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.printf((info) => {
      const message = typeof info.message === 'string' ? info.message : formatLogArgs(info.message);
      if (typeof info.stack === 'string' && info.stack) {
        return `${message}\n${info.stack}`;
      }
      return message;
    })
  );
};

const createFileFormatter = () => {
  return winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.printf((info) => {
      const timestamp = new Date().toISOString();
      const message = typeof info.message === 'string' ? info.message : formatLogArgs(info.message);

      const contextParts: string[] = [];
      if (info.workspaceName) {
        contextParts.push(`[W:${info.workspaceName}]`);
      }
      if (info.sessionId) {
        contextParts.push(`[S-${info.sessionId}]`);
      }
      if (info.scope) {
        contextParts.push(`[${info.scope}]`);
      }
      const contextPrefix = contextParts.length > 0 ? ` ${contextParts.join(' ')}` : '';

      const level = info.level.toUpperCase();
      const baseLog = `${timestamp} [${level}]${contextPrefix} ${message}`;

      if (typeof info.stack === 'string' && info.stack) {
        return `${baseLog}\n${info.stack}`;
      }
      return baseLog;
    })
  );
};

const createConsoleTransport = (config: LoggerConfig) => {
  return new winston.transports.Console({
    level: config.level === 'silent' ? 'error' : config.level || 'info',
    format: createConsoleFormatter(),
  });
};

const asFileLogSink = (transport: DailyRotateFile): FileLogSink => {
  const logStream: unknown = Reflect.get(transport, 'logStream');
  if (!(logStream instanceof EventEmitter)) {
    throw new Error('winston-daily-rotate-file no longer exposes logStream');
  }
  return Object.assign(transport, { logStream });
};

export const createFileTransport = (
  config: LoggerConfig,
  seams: Partial<Pick<ResilientFileTransportOptions, 'now' | 'probeWritable' | 'writeStderr'>> = {}
): ResilientFileTransport => {
  const fileConfig = config.file || {};
  const dirname = fileConfig.dirname || LODY_LOG_DIR;

  if (!cleanedLogDirs.has(dirname)) {
    try {
      cleanupExpiredLogs(dirname);
    } catch {}
    cleanedLogDirs.add(dirname);
  }

  return new ResilientFileTransport({
    level: resolveFileLogLevel(),
    format: createFileFormatter(),
    dirname,
    openSink: () =>
      asFileLogSink(
        new DailyRotateFile({
          filename: fileConfig.filename || `%DATE%.log`,
          dirname,
          datePattern: fileConfig.datePattern || 'YYYY-MM-DD',
          maxSize: fileConfig.maxSize || '20m',
          maxFiles: fileConfig.maxFiles || LODY_LOG_RETENTION_MAX_FILES,
          zippedArchive: fileConfig.zippedArchive ?? true,
        })
      ),
    probeWritable: () => probeDirectoryWritable(dirname),
    ...seams,
  });
};

class WinstonLogger implements Logger {
  private winston: winston.Logger;
  private config: LoggerConfig;

  static routeToStderr(logger: Logger): () => void {
    if (!(logger instanceof WinstonLogger)) return () => {};
    const restore: Array<() => void> = [];
    for (const transport of logger.winston.transports) {
      if (!(transport instanceof winston.transports.Console)) continue;
      const previous = transport.stderrLevels;
      Reflect.set(
        transport,
        'stderrLevels',
        Object.fromEntries(Object.keys(LOG_LEVELS).map((level) => [level, true]))
      );
      restore.push(() => {
        transport.stderrLevels = previous;
      });
    }
    return () => {
      restore.forEach((reset) => reset());
    };
  }

  constructor(config: LoggerConfig = {}, childWinston?: winston.Logger) {
    this.config = { ...config };
    this.winston = childWinston ?? this.createWinstonLogger();
  }

  private createWinstonLogger(): winston.Logger {
    const transports: winston.transport[] = [];
    const transportType = this.config.transports || 'console';

    if (transportType === 'console' || transportType === 'both') {
      transports.push(createConsoleTransport(this.config));
    }

    if (transportType === 'file' || transportType === 'both') {
      transports.push(createFileTransport(this.config));
    }

    return winston.createLogger({
      levels: LOG_LEVELS,
      level: 'trace',
      transports,
      exitOnError: false,
    });
  }

  info = (...args: unknown[]): void => {
    this.winston.info(formatLogArgs(...args));
  };

  warn = (...args: unknown[]): void => {
    this.winston.warn(formatLogArgs(...args));
  };

  error = (...args: unknown[]): void => {
    this.winston.error(formatLogArgs(...args));
  };

  success = (...args: unknown[]): void => {
    const message = formatLogArgs(...args);
    this.winston.info(message);
  };

  debug = (...args: unknown[]): void => {
    this.winston.debug(formatLogArgs(...args));
  };

  trace = (...args: unknown[]): void => {
    this.winston.log('trace', formatLogArgs(...args));
  };

  setLevel = (level: LogLevel): void => {
    this.config.level = level;
    this.winston.level = 'trace';

    this.winston.transports.forEach((transport: winston.transport) => {
      if (transport instanceof winston.transports.Console) {
        transport.level = level === 'silent' ? 'error' : level;
        transport.silent = level === 'silent';
      } else if (transport instanceof ResilientFileTransport) {
        transport.level = resolveFileLogLevel();
      }
    });
  };

  setDebug = (enabled: boolean): void => {
    if (enabled) {
      this.setLevel('debug');
    }
  };

  child = (defaultMeta: LogMeta): Logger =>
    new WinstonLogger(this.config, this.winston.child(defaultMeta));

  close = async (): Promise<void> => {
    return new Promise((resolve) => {
      this.winston.close();
      resolve();
    });
  };
}

let defaultLoggerInstance: Logger | null = null;

export const createLogger = (config: LoggerConfig = {}): Logger => {
  return new WinstonLogger(config);
};

export const createFileLogger = (filename?: string, dirname?: string): Logger => {
  const logger = createLogger({
    transports: 'file',
    level: 'info',
    file: {
      filename: filename || '%DATE%.log',
      dirname: dirname || LODY_LOG_DIR,
      maxSize: '20m',
      maxFiles: LODY_LOG_RETENTION_MAX_FILES,
      zippedArchive: true,
    },
  });
  rootLogger = logger;
  const desktopBuild = getDesktopBuildDescription();
  if (desktopBuild !== null) logger.debug(`[desktop-build] ${desktopBuild}`);
  return logger;
};

export const createHybridLogger = (config: Partial<LoggerConfig> = {}): Logger => {
  const logger = createLogger({
    transports: 'both',
    level: 'info',
    console: {
      colorize: true,
      timestamp: false,
      format: 'simple',
    },
    file: {
      dirname: LODY_LOG_DIR,
      maxSize: '20m',
      maxFiles: LODY_LOG_RETENTION_MAX_FILES,
      zippedArchive: true,
    },
    ...config,
  });
  rootLogger = logger;
  const desktopBuild = getDesktopBuildDescription();
  if (desktopBuild !== null) logger.debug(`[desktop-build] ${desktopBuild}`);
  return logger;
};

export const getDefaultLogger = (): Logger => {
  if (!defaultLoggerInstance) {
    defaultLoggerInstance = createLogger({
      transports: 'console',
      level: 'info',
      console: {
        colorize: true,
        timestamp: false,
        format: 'simple',
      },
    });
  }
  return defaultLoggerInstance;
};

export let rootLogger = getDefaultLogger();

/** Keep a structured command's stdout parseable, including diagnostics from children. */
export const routeLoggerToStderr = (logger: Logger = rootLogger): (() => void) =>
  WinstonLogger.routeToStderr(logger);

/**
 * A scoped logger that binds to the CURRENT root on every write. Entry modules
 * obtain loggers at import time, before a command installs the process sink
 * (`createHybridLogger`/`createFileLogger`); a child captured then would keep
 * writing to the startup console logger — for a daemon Worker, a discarded pipe.
 */
class ScopedLogger implements Logger {
  private bound: { readonly root: Logger; readonly logger: Logger } | undefined;

  constructor(private readonly meta: LogMeta) {}

  private current(): Logger {
    const root = rootLogger;
    if (this.bound?.root !== root) {
      this.bound = { root, logger: Object.keys(this.meta).length ? root.child(this.meta) : root };
    }
    return this.bound.logger;
  }

  info = (...args: unknown[]): void => this.current().info(...args);
  warn = (...args: unknown[]): void => this.current().warn(...args);
  error = (...args: unknown[]): void => this.current().error(...args);
  success = (...args: unknown[]): void => this.current().success(...args);
  debug = (...args: unknown[]): void => this.current().debug(...args);
  trace = (...args: unknown[]): void => this.current().trace(...args);
  setLevel = (level: LogLevel): void => this.current().setLevel(level);
  setDebug = (enabled: boolean): void => this.current().setDebug(enabled);
  child = (defaultMeta: LogMeta): Logger => new ScopedLogger({ ...this.meta, ...defaultMeta });
  close = (): Promise<void> => this.current().close();
}

export const getLogger = (scope?: string, meta?: Record<string, unknown>): Logger => {
  if (!scope && !meta) {
    return rootLogger;
  }
  return new ScopedLogger({
    ...(scope ? { scope } : {}),
    ...meta,
  });
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LogMeta = Record<string, any>;

export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  success: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  /**
   * High-frequency diagnostics that would otherwise evict useful history from
   * the rotation window. Excluded from the file sink unless LODY_LOG_TRACE is set.
   */
  trace: (...args: unknown[]) => void;

  setLevel: (level: LogLevel) => void;
  setDebug: (enabled: boolean) => void;
  child: (defaultMeta: LogMeta) => Logger;
  close: () => Promise<void>;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export type LogTransport = 'console' | 'file' | 'both';

export interface LoggerConfig {
  level?: LogLevel;
  transports?: LogTransport;

  file?: {
    filename?: string;
    dirname?: string;
    maxSize?: string;
    maxFiles?: number | string;
    datePattern?: string;
    zippedArchive?: boolean;
  };

  console?: {
    colorize?: boolean;
    timestamp?: boolean;
    format?: 'simple' | 'detailed' | 'json';
  };
}
