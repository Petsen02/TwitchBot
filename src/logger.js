import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './config.js';

/**
 * File logging and crash reports.
 *
 * The panel console only keeps what fits on screen and loses everything on
 * restart, which is exactly the wrong behaviour for the minutes before a
 * crash. Everything written to the console is therefore mirrored to a dated
 * file, and an unhandled failure writes a standalone report containing the
 * last lines of output leading up to it.
 */

const LOG_DIR = join(projectRoot, 'logs');
const CRASH_DIR = join(projectRoot, 'crashes');
const RETENTION_DAYS = 14;
const TAIL_SIZE = 150;

mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(CRASH_DIR, { recursive: true });

// Kept in memory so a crash report can show what happened just before it.
const recent = [];

function stamp(date = new Date()) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function logFileFor(date = new Date()) {
  return join(LOG_DIR, `bot-${date.toISOString().slice(0, 10)}.log`);
}

function write(level, text) {
  const line = `[${stamp()}] ${level} ${text}`;

  recent.push(line);
  if (recent.length > TAIL_SIZE) recent.shift();

  try {
    appendFileSync(logFileFor(), `${line}\n`, 'utf8');
  } catch {
    // Never let logging failure take the bot down.
  }
}

function format(args) {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return arg.stack ?? arg.message;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

/**
 * Mirrors console output to file rather than replacing it: the panel console
 * keeps working, and third-party libraries are captured too without having to
 * route them through a logger they know nothing about.
 */
function tee(method, level) {
  const original = console[method].bind(console);

  console[method] = (...args) => {
    write(level, format(args));
    original(...args);
  };
}

tee('log', 'INFO ');
tee('info', 'INFO ');
tee('warn', 'WARN ');
tee('error', 'ERROR');

/** Removes log files older than the retention window. */
function pruneLogs() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  for (const dir of [LOG_DIR, CRASH_DIR]) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }

    for (const name of names) {
      const match = name.match(/(\d{4}-\d{2}-\d{2})/);
      if (!match) continue;

      if (new Date(match[1]).getTime() < cutoff) {
        try {
          unlinkSync(join(dir, name));
        } catch {
          // A file we cannot delete is not worth crashing over.
        }
      }
    }
  }
}

function writeCrashReport(kind, error) {
  const now = new Date();
  const file = join(CRASH_DIR, `crash-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.log`);

  const report = [
    `Crash report — ${stamp(now)}`,
    `Kind      : ${kind}`,
    `Node      : ${process.version}`,
    `Uptime    : ${Math.round(process.uptime())}s`,
    `Memory    : ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB RSS`,
    '',
    '--- Error ---',
    error?.stack ?? String(error),
    '',
    `--- Last ${recent.length} log lines ---`,
    ...recent,
    '',
  ].join('\n');

  try {
    appendFileSync(file, report, 'utf8');
    console.error(`[crash] report written to ${file}`);
  } catch (writeError) {
    console.error('[crash] could not write report:', writeError.message);
  }
}

/**
 * Installs the process-level handlers.
 *
 * `onShutdown` is given a chance to persist state before exit — LP history is
 * measured, not recoverable, so losing an unsaved snapshot matters.
 */
export function installCrashHandlers(onShutdown = () => {}) {
  pruneLogs();

  const finish = (code) => {
    try {
      onShutdown();
    } catch (error) {
      console.error('[shutdown] failed:', error.message);
    }
    process.exit(code);
  };

  process.on('uncaughtException', (error) => {
    writeCrashReport('uncaughtException', error);
    finish(1);
  });

  process.on('unhandledRejection', (reason) => {
    writeCrashReport('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
    finish(1);
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`[bot] received ${signal}, shutting down`);
      finish(0);
    });
  }
}

export const logPaths = { logs: LOG_DIR, crashes: CRASH_DIR };
