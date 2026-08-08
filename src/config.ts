import { Effect } from "effect";
import {
  ConfigError as KitConfigError,
  fromProcessEnv,
  parseBooleanEnv,
  parseTimeoutEnv,
  type EnvReader,
} from "@lidless-labs/effect-operator-kit";

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface LibreNmsConfig {
  url: string;
  token: string;
  tlsInsecure: boolean;
  requestTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Bridge kit Effect config primitives to this repo's sync throw-on-error contract.
 */
function runConfigEffect<A>(effect: Effect.Effect<A, KitConfigError>): A {
  const result = Effect.runSync(Effect.either(effect));
  if (result._tag === "Left") {
    throw new ConfigError(result.left.message);
  }
  return result.right;
}

/**
 * Kit `parseBooleanEnv` trims values, accepts on/off, and throws on invalid tokens.
 * LibreNMS env parsing silently coerces invalid values to false and only accepts
 * true/1/yes without trimming.
 */
function parseTlsInsecure(env: EnvReader): boolean {
  const raw = env.get("LIBRENMS_TLS_INSECURE");
  if (!raw) return false;
  if (["true", "1", "yes"].includes(raw.toLowerCase())) {
    return runConfigEffect(parseBooleanEnv(env, "LIBRENMS_TLS_INSECURE", false));
  }
  return false;
}

function parseRequestTimeoutMs(env: EnvReader): number {
  return runConfigEffect(
    parseTimeoutEnv(env, "LIBRENMS_REQUEST_TIMEOUT_MS", {
      fallbackMs: DEFAULT_REQUEST_TIMEOUT_MS,
      minMs: 1000,
      unit: "ms",
    }),
  );
}

export function resolveConfig(env: Record<string, string | undefined>): LibreNmsConfig {
  const reader = fromProcessEnv(env as NodeJS.ProcessEnv);

  const url = env.LIBRENMS_URL;
  const token = env.LIBRENMS_TOKEN;
  if (!url) throw new ConfigError("LIBRENMS_URL is required");
  if (!token) throw new ConfigError("LIBRENMS_TOKEN is required");
  return {
    url: url.replace(/\/+$/, ""),
    token,
    tlsInsecure: parseTlsInsecure(reader),
    requestTimeoutMs: parseRequestTimeoutMs(reader),
  };
}
