import crypto from 'node:crypto';
import { DEFAULT_PORT, DEFAULT_HOST, readConfig } from './paths.js';

/** A shared secret on a team-reachable port is the whole security model. */
export const MIN_TOKEN_LENGTH = 16;

const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

export function isLoopback(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK.includes(h);
}

/**
 * Settings come from flags, then the environment, then the config file, then
 * defaults. There is deliberately no "server mode": a company deployment is
 * two environment variables, not a second code path.
 */
export function resolve({ flags = {}, env = process.env, file = readConfig(), makeToken = newToken } = {}) {
  const port = Number(flags.port) || Number(env.AGENT_CCTV_PORT) || Number(file.port) || DEFAULT_PORT;
  const host = flags.host || env.AGENT_CCTV_HOST || file.host || DEFAULT_HOST;

  const noToken = flags['no-token'] === true || flags.token === false;
  const token = noToken ? null : env.AGENT_CCTV_TOKEN || makeToken();

  const publicUrlRaw = flags['public-url'] || env.AGENT_CCTV_PUBLIC_URL || null;
  let publicHost = null;
  let secureCookie = false;
  if (publicUrlRaw) {
    try {
      const u = new URL(publicUrlRaw);
      publicHost = u.hostname.toLowerCase().replace(/^\[|\]$/g, '') || null;
      secureCookie = u.protocol === 'https:';
    } catch {
      publicHost = null; // validate() turns this into a refusal
    }
  }

  const openBrowser = !(flags['no-open'] === true || flags.open === false);

  return {
    port,
    host,
    token,
    noToken,
    publicUrlRaw,
    publicHost,
    secureCookie,
    openBrowser,
    allowedHosts: publicHost ? [...LOOPBACK, publicHost] : [...LOOPBACK],
  };
}

/** Every refusal exits before the socket binds. */
export function validate(cfg) {
  if (cfg.publicUrlRaw && !cfg.publicHost) {
    throw new ConfigError(
      `AGENT_CCTV_PUBLIC_URL is not a valid absolute URL: ${cfg.publicUrlRaw}\n` +
        `  Expected something like https://cctv.example.com`
    );
  }

  // A configured public URL means "reachable beyond this machine" just as
  // surely as a non-loopback bind does — a reverse proxy in front of a
  // loopback bind is still exposing the dashboard to whoever can reach that
  // proxy's hostname.
  const remoteViaHost = !isLoopback(cfg.host);
  const remoteViaPublicUrl = !!cfg.publicHost;
  if ((remoteViaHost || remoteViaPublicUrl) && !cfg.token) {
    if (cfg.noToken) {
      throw new ConfigError(
        remoteViaHost
          ? `--no-token cannot be combined with --host ${cfg.host}.\n` +
            `  The dashboard serves your transcripts, which contain source code.\n` +
            `  Drop --no-token, or bind 127.0.0.1.`
          : `--no-token cannot be combined with AGENT_CCTV_PUBLIC_URL (${cfg.publicUrlRaw}).\n` +
            `  The dashboard serves your transcripts, which contain source code.\n` +
            `  Drop --no-token, or remove AGENT_CCTV_PUBLIC_URL.`
      );
    }
    throw new ConfigError(
      remoteViaHost
        ? `Refusing to bind ${cfg.host} without a token.\n` +
          `  The dashboard serves your transcripts, which contain source code.\n` +
          `  Set AGENT_CCTV_TOKEN to a secret of at least ${MIN_TOKEN_LENGTH} characters,\n` +
          `  or bind 127.0.0.1 and put a reverse proxy in front.`
        : `Refusing to run with AGENT_CCTV_PUBLIC_URL (${cfg.publicUrlRaw}) set and no token.\n` +
          `  A public URL means a reverse proxy makes this reachable beyond this machine.\n` +
          `  Set AGENT_CCTV_TOKEN to a secret of at least ${MIN_TOKEN_LENGTH} characters,\n` +
          `  or remove AGENT_CCTV_PUBLIC_URL.`
    );
  }

  if (cfg.token && cfg.token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(
      `AGENT_CCTV_TOKEN is too short: ${cfg.token.length} characters, minimum ${MIN_TOKEN_LENGTH}.\n` +
        `  Generate one with:  openssl rand -hex 32`
    );
  }

  return cfg;
}
