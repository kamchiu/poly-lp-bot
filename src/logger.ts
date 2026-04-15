import winston from 'winston';
import { join } from 'node:path';

// const logger = winston.createLogger({
//   level: process.env.LOG_LEVEL ?? 'info',
//   format: winston.format.combine(
//     winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
//     winston.format.printf(({ timestamp, level, message, ...meta }) => {
//       const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
//       return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}`;
//     })
//   ),
//   transports: [new winston.transports.Console()],
// });


// Log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

// Log colors
const colors = {
  error: "red",
  warn: "yellow",
  info: "green",
  debug: "blue",
};

winston.addColors(colors);

// Custom format
const format = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Console format (for development)
const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

// Determine log level from environment
const logLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug");

// Create logger
const logger = winston.createLogger({
  level: logLevel,
  levels,
  format,
  transports: [
    // Console transport
    new winston.transports.Console({
      format: consoleFormat,
    }),
    // File transport for errors
    new winston.transports.File({
      filename: join(__dirname, "..", "logs", "error.log"),
      level: "error",
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // File transport for all logs
    new winston.transports.File({
      filename: join(__dirname, "..", "logs", "combined.log"),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
  ],
  // Handle exceptions
  exceptionHandlers: [
    new winston.transports.File({
      filename: join(__dirname, "..", "logs", "exceptions.log"),
    }),
  ],
  // Handle promise rejections
  rejectionHandlers: [
    new winston.transports.File({
      filename: join(__dirname, "..", "logs", "rejections.log"),
    }),
  ],
});

export default logger;
