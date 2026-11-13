// Types for the logger in src/utils/log.ts.

export type LogLevel = 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export type LogSink = (level: LogLevel, line: string) => void;
