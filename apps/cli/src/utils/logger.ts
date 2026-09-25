import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { formatLogArgs } from './log-format';
import { getDesktopBuildDescription } from './desktop-build';
import { cleanupExpiredLogs, LODY_LOG_DIR, LODY_LOG_RETENTION_MAX_FILES } from './log-retention';

const cleanedLogDirs = new Set<string>();

// 自定义格式化器 (控制台 - 无时间戳)
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

// 自定义格式化器 (文件 - 带时间戳和上下文)
const createFileFormatter = () => {
  return winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.printf((info) => {
      const timestamp = new Date().toISOString();
      const message = typeof info.message === 'string' ? info.message : formatLogArgs(info.message);

      // Build context prefix from metadata
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

// 控制台传输配置
const createConsoleTransport = (config: LoggerConfig) => {
  return new winston.transports.Console({
    level: config.level === 'silent' ? 'error' : config.level || 'info',
    format: createConsoleFormatter(),
  });
};

// 文件传输配置
// File transport always logs at debug level to capture all logs for diagnostics
const createFileTransport = (config: LoggerConfig) => {
  const fileConfig = config.file || {};
  const dirname = fileConfig.dirname || LODY_LOG_DIR;

  if (!cleanedLogDirs.has(dirname)) {
    try {
      cleanupExpiredLogs(dirname);
    } catch {
      // Best effort only: log retention should never block logger initialization.
    }
    cleanedLogDirs.add(dirname);
  }

  return new DailyRotateFile({
    level: 'debug',
    filename: fileConfig.filename || `%DATE%.log`,
    dirname,
    datePattern: fileConfig.datePattern || 'YYYY-MM-DD',
    maxSize: fileConfig.maxSize || '20m',
    maxFiles: fileConfig.maxFiles || LODY_LOG_RETENTION_MAX_FILES,
    zippedArchive: fileConfig.zippedArchive ?? true,
    format: createFileFormatter(),
  });
};

class WinstonLogger implements Logger {
  private winston: winston.Logger;
  private config: LoggerConfig;

  constructor(config: LoggerConfig = {}, childWinston?: winston.Logger) {
    this.config = { ...config };
    this.winston = childWinston ?? this.createWinstonLogger();
  }

  private createWinstonLogger(): winston.Logger {
    const transports: winston.transport[] = [];
    const transportType = this.config.transports || 'console';

    // 添加控制台传输
    if (transportType === 'console' || transportType === 'both') {
      transports.push(createConsoleTransport(this.config));
    }

    // 添加文件传输
    if (transportType === 'file' || transportType === 'both') {
      transports.push(createFileTransport(this.config));
    }

    // Error reporting is no longer wired into the logger. Crashes reach PostHog
    // error tracking via the process-level handlers (utils/telemetry.ts) and
    // explicit captureException calls; logger.error stays a pure log sink.

    // Set logger level to debug to allow all messages through to transports.
    // Each transport controls its own filtering level:
    // - Console: respects config.level (default info)
    // - File: always debug to capture all logs for diagnostics
    return winston.createLogger({
      level: 'debug',
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
    // 错误总是输出，即使在silent模式
    this.winston.error(formatLogArgs(...args));
  };

  success = (...args: unknown[]): void => {
    const message = formatLogArgs(...args);
    this.winston.info(message);
  };

  debug = (...args: unknown[]): void => {
    this.winston.debug(formatLogArgs(...args));
  };

  setLevel = (level: LogLevel): void => {
    this.config.level = level;
    // Set logger level to debug to allow all messages through to transports
    // Each transport controls its own filtering level
    this.winston.level = 'debug';

    // Update transport levels - file always stays at debug, console follows config
    this.winston.transports.forEach((transport: winston.transport) => {
      if (transport instanceof winston.transports.Console) {
        transport.level = level === 'silent' ? 'error' : level;
        transport.silent = level === 'silent';
      } else if (transport instanceof DailyRotateFile) {
        // File transport always logs at debug level
        transport.level = 'debug';
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

// 默认logger实例
let defaultLoggerInstance: Logger | null = null;

// 创建logger工厂函数
export const createLogger = (config: LoggerConfig = {}): Logger => {
  return new WinstonLogger(config);
};

// 创建文件logger
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

// 创建混合logger（console + file）
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

// 获取默认logger
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

export const getLogger = (scope?: string, meta?: Record<string, unknown>): Logger => {
  if (!scope && !meta) {
    return rootLogger;
  }
  return rootLogger.child({
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

  setLevel: (level: LogLevel) => void;
  setDebug: (enabled: boolean) => void;
  child: (defaultMeta: LogMeta) => Logger;
  close: () => Promise<void>;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'silent';

export type LogTransport = 'console' | 'file' | 'both';

export interface LoggerConfig {
  level?: LogLevel;
  transports?: LogTransport;

  // 文件输出配置
  file?: {
    filename?: string;
    dirname?: string;
    maxSize?: string;
    maxFiles?: number | string;
    datePattern?: string;
    zippedArchive?: boolean;
  };

  // 控制台输出配置
  console?: {
    colorize?: boolean;
    timestamp?: boolean;
    format?: 'simple' | 'detailed' | 'json';
  };
}
