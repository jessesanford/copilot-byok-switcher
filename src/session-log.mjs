// Router diagnostics go to a file, not to stderr.
//
// Copilot draws a full-screen TUI: anything written to the inherited stderr lands
// on top of it and garbles the display. Errors are appended to a log instead, and
// a one-line summary is printed after Copilot exits, when the screen is ours again.

import { appendFileSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MAX_LOG_BYTES = 2 * 1024 * 1024;

export function logPath(env = process.env) {
  if (env.COPILOT_BYOK_LOG) return env.COPILOT_BYOK_LOG;

  if (process.platform === 'win32' && env.APPDATA) {
    return join(env.APPDATA, 'copilot-byok', 'router.log');
  }

  const base = env.XDG_STATE_HOME || env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'copilot-byok', 'router.log');
}

/**
 * @param {object} io  The usual { stderr, env } pair.
 * @returns {{onEvent: function, summarize: function, path: string, errors: number}}
 */
export function createSessionLog(io) {
  const path = logPath(io.env);
  const debug = Boolean(io.env.COPILOT_BYOK_DEBUG);
  let errors = 0;
  let writable = true;

  try {
    mkdirSync(dirname(path), { recursive: true });
    // Keep a single file rather than growing forever or littering one per session.
    if (statSync(path, { throwIfNoEntry: false })?.size > MAX_LOG_BYTES) truncateSync(path, 0);
  } catch {
    writable = false;
  }

  const write = (line) => {
    if (!writable) return;
    try {
      appendFileSync(path, `${new Date().toISOString()} [${process.pid}] ${line}\n`, 'utf8');
    } catch {
      writable = false; // a read-only home must not break the session
    }
  };

  return {
    path,
    get errors() {
      return errors;
    },

    onEvent(event) {
      if (event.type === 'error') {
        errors += 1;
        write(`error: ${event.provider ? `${event.provider}: ` : ''}${event.message}`);
      } else if (event.type === 'notice') {
        // Something adapted rather than failed: worth recording, not worth alarming.
        write(`notice: ${event.provider ? `${event.provider}: ` : ''}${event.message}`);
      } else if (event.type === 'route') {
        const shape = event.adapter
          ? ` via ${event.adapter} ${event.inboundPath || '?'} -> ${event.outboundPath || '?'}`
            + ` messages=${event.messageCount ?? '?'} tools=${event.toolCount ?? '?'}`
            + (event.roles?.length ? ` roles=${event.roles.join(',')}` : '')
          : '';
        write(`route: ${event.provider} -> ${event.model}${shape}`);
      } else if (event.type === 'models') {
        write(`models: upstream ${event.status}, ${event.injected} BYOK entries added`);
      }

      // With debugging on, the caller has accepted a garbled screen in exchange
      // for seeing events as they happen.
      if (debug) io.stderr.write(`copilot-byok: ${event.type}: ${event.message || `${event.provider || ''} ${event.model || ''}`.trim()}\n`);
    },

    /** Printed once Copilot has exited and the terminal is usable again. */
    summarize() {
      if (errors === 0) return;
      const noun = errors === 1 ? 'error' : 'errors';
      io.stderr.write(`\ncopilot-byok: ${errors} router ${noun} during this session — see ${path}\n`);
    },
  };
}
