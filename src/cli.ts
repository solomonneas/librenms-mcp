import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveConfig } from "./config.ts";
import { LibreNmsClient } from "./librenms-client.ts";
import { boundaryErrorMessage } from "./error-message.ts";
import { redact } from "./security.ts";
import { ValidationError } from "./validate.ts";
import { serve } from "../mcp-server.ts";

export const VERSION = "0.2.0";

export class UsageError extends Error {}

type DeviceType = "all" | "up" | "down" | "ignored" | "disabled";
type HealthMetric = "errors_in" | "errors_out" | "utilization";
type AlertState = 0 | 1 | 2;

export type Parsed =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "mcp" }
  | { kind: "status"; json: boolean }
  | { kind: "devices-list"; json: boolean; type: DeviceType | undefined }
  | { kind: "devices-get"; json: boolean; hostname: string }
  | { kind: "ports-list"; json: boolean; hostname: string }
  | { kind: "ports-get"; json: boolean; portId: number }
  | { kind: "ports-health"; json: boolean; metric: HealthMetric; limit: number }
  | { kind: "alerts-list"; json: boolean; state: AlertState | undefined }
  | { kind: "alerts-get"; json: boolean; id: number }
  | { kind: "alerts-history"; json: boolean; deviceId: number | undefined; limit: number }
  | { kind: "events-list"; json: boolean; deviceId: number | undefined; limit: number };

export const HELP = `librenmsctrl - read-only operator CLI for a LibreNMS instance

Usage:
  librenmsctrl <command> [subcommand] [args] [options]

Commands:
  status                       LibreNMS system health (version, totals, last poll)
  devices list                 List monitored devices
  devices get <hostname>       Fetch a single device by hostname
  ports list <hostname>        List ports on a device
  ports get <port_id>          Single-port detail by LibreNMS port id
  ports health                 Rank ports by error/utilization counters
  alerts list                  List alerts
  alerts get <id>              Fetch a single alert by id
  alerts history               Recent alert-log entries
  events list                  Recent device event-log entries
  mcp                          Start the MCP server over stdio
  help                         Show this help

Global options:
  --json                       Emit raw JSON instead of human-readable text
  --version, -v                Print version
  --help, -h                   Show help

Command options:
  devices list  --type <t>     all | up | down | ignored | disabled
  ports health  --metric <m>   errors_in | errors_out | utilization (default errors_in)
                --limit <n>    Top N ports (default 10)
  alerts list   --state <s>    0=ok | 1=active | 2=ack
  alerts history --device-id <n>  Scope to a device id
                 --limit <n>      Max entries (default 25)
  events list   --device-id <n>   Scope to a device id
                --limit <n>       Max entries (default 25)

Environment:
  LIBRENMS_URL            Base URL of the LibreNMS instance (required)
  LIBRENMS_TOKEN          X-Auth-Token API token (required)
  LIBRENMS_TLS_INSECURE   Set truthy to skip TLS verification (self-signed hosts)
  LIBRENMS_REQUEST_TIMEOUT_MS  Per-request HTTP timeout in ms (default 30000, min 1000)`;

function takeFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function ensureNoExtra(args: string[]): void {
  if (args.length) throw new UsageError(`Unexpected arguments: ${args.join(" ")}`);
}

function requireValue(v: string | undefined, name: string): string {
  if (v === undefined || v.startsWith("--")) throw new UsageError(`${name} requires a value`);
  return v;
}

function requireInt(v: string | undefined, name: string, min: number, max: number): number {
  const n = Number(requireValue(v, name));
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UsageError(`${name} must be an integer in [${min}, ${max}]`);
  }
  return n;
}

function requireEnum<T extends string>(v: string | undefined, allowed: readonly T[], name: string): T {
  const s = requireValue(v, name);
  if (!(allowed as readonly string[]).includes(s)) {
    throw new UsageError(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return s as T;
}

function requirePositional(args: string[], name: string): string {
  const v = args.shift();
  if (v === undefined || v.startsWith("--")) throw new UsageError(`${name} is required`);
  return v;
}

function requirePositionalInt(args: string[], name: string, min: number): number {
  const raw = requirePositional(args, name);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new UsageError(`${name} must be an integer >= ${min}`);
  }
  return n;
}

function parseDevices(args: string[], json: boolean): Parsed {
  const sub = args.shift();
  if (sub === "list") {
    let type: DeviceType | undefined;
    while (args.length) {
      const a = args.shift() as string;
      if (a === "--type") {
        type = requireEnum(args.shift(), ["all", "up", "down", "ignored", "disabled"] as const, "--type");
      } else {
        throw new UsageError(a.startsWith("--") ? `Unknown option: ${a}` : `Unexpected argument: ${a}`);
      }
    }
    return { kind: "devices-list", json, type };
  }
  if (sub === "get") {
    const hostname = requirePositional(args, "hostname");
    ensureNoExtra(args);
    return { kind: "devices-get", json, hostname };
  }
  throw new UsageError(`Unknown devices subcommand: ${sub ?? "(none)"} (expected list|get)`);
}

function parsePorts(args: string[], json: boolean): Parsed {
  const sub = args.shift();
  if (sub === "list") {
    const hostname = requirePositional(args, "hostname");
    ensureNoExtra(args);
    return { kind: "ports-list", json, hostname };
  }
  if (sub === "get") {
    const portId = requirePositionalInt(args, "port_id", 1);
    ensureNoExtra(args);
    return { kind: "ports-get", json, portId };
  }
  if (sub === "health") {
    let metric: HealthMetric = "errors_in";
    let limit = 10;
    while (args.length) {
      const a = args.shift() as string;
      if (a === "--metric") {
        metric = requireEnum(args.shift(), ["errors_in", "errors_out", "utilization"] as const, "--metric");
      } else if (a === "--limit") {
        limit = requireInt(args.shift(), "--limit", 1, 1000);
      } else {
        throw new UsageError(a.startsWith("--") ? `Unknown option: ${a}` : `Unexpected argument: ${a}`);
      }
    }
    return { kind: "ports-health", json, metric, limit };
  }
  throw new UsageError(`Unknown ports subcommand: ${sub ?? "(none)"} (expected list|get|health)`);
}

function parseAlerts(args: string[], json: boolean): Parsed {
  const sub = args.shift();
  if (sub === "list") {
    let state: AlertState | undefined;
    while (args.length) {
      const a = args.shift() as string;
      if (a === "--state") {
        state = requireInt(args.shift(), "--state", 0, 2) as AlertState;
      } else {
        throw new UsageError(a.startsWith("--") ? `Unknown option: ${a}` : `Unexpected argument: ${a}`);
      }
    }
    return { kind: "alerts-list", json, state };
  }
  if (sub === "get") {
    const id = requirePositionalInt(args, "id", 1);
    ensureNoExtra(args);
    return { kind: "alerts-get", json, id };
  }
  if (sub === "history") {
    const { deviceId, limit } = parseLogOptions(args);
    return { kind: "alerts-history", json, deviceId, limit };
  }
  throw new UsageError(`Unknown alerts subcommand: ${sub ?? "(none)"} (expected list|get|history)`);
}

function parseEvents(args: string[], json: boolean): Parsed {
  const sub = args.shift();
  if (sub === "list") {
    const { deviceId, limit } = parseLogOptions(args);
    return { kind: "events-list", json, deviceId, limit };
  }
  throw new UsageError(`Unknown events subcommand: ${sub ?? "(none)"} (expected list)`);
}

function parseLogOptions(args: string[]): { deviceId: number | undefined; limit: number } {
  let deviceId: number | undefined;
  let limit = 25;
  while (args.length) {
    const a = args.shift() as string;
    if (a === "--device-id") {
      deviceId = requireInt(args.shift(), "--device-id", 1, Number.MAX_SAFE_INTEGER);
    } else if (a === "--limit") {
      limit = requireInt(args.shift(), "--limit", 1, 10000);
    } else {
      throw new UsageError(a.startsWith("--") ? `Unknown option: ${a}` : `Unexpected argument: ${a}`);
    }
  }
  return { deviceId, limit };
}

export function parseArgs(argv: string[]): Parsed {
  const args = [...argv];
  if (args.includes("-h") || args.includes("--help")) return { kind: "help" };
  if (args.includes("-v") || args.includes("--version")) return { kind: "version" };

  const cmd = args.shift();
  if (!cmd || cmd === "help") return { kind: "help" };
  if (cmd === "mcp") return { kind: "mcp" };

  const json = takeFlag(args, "--json");
  switch (cmd) {
    case "status":
      ensureNoExtra(args);
      return { kind: "status", json };
    case "devices":
      return parseDevices(args, json);
    case "ports":
      return parsePorts(args, json);
    case "alerts":
      return parseAlerts(args, json);
    case "events":
      return parseEvents(args, json);
    default:
      throw new UsageError(`Unknown command: ${cmd}`);
  }
}

// ---- response shapes (mirrors the read-only API surface used by the tools) ----

interface Row {
  [key: string]: unknown;
}

function asStr(v: unknown): string {
  if (v === null || v === undefined) return "-";
  return String(v);
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function renderSystem(system: Row): string {
  const lines = ["LibreNMS system:"];
  const keys: Array<[string, string]> = [
    ["local_hostname", "host"],
    ["version", "version"],
    ["db_schema", "db_schema"],
    ["php_ver", "php"],
    ["database_ver", "db_ver"],
    ["rrdcached", "rrdcached"],
  ];
  for (const [k, label] of keys) {
    if (system[k] !== undefined) lines.push(`  ${label}: ${asStr(system[k])}`);
  }
  return lines.join("\n");
}

function renderDevices(devices: Row[]): string {
  if (!devices.length) return "No devices.";
  const lines = [`${devices.length} device(s):`];
  for (const d of devices) {
    const up = d.status === 1 || d.status === "1" ? "up" : "down";
    lines.push(`  [${asStr(d.device_id)}] ${asStr(d.hostname)}  ${up}  os=${asStr(d.os)}  hw=${asStr(d.hardware)}`);
  }
  return lines.join("\n");
}

function renderDevice(device: Row | null): string {
  if (!device) return "Device not found.";
  const lines = [`Device ${asStr(device.hostname)} [${asStr(device.device_id)}]`];
  for (const k of ["sysName", "os", "version", "hardware", "status", "uptime", "location"]) {
    if (device[k] !== undefined) lines.push(`  ${k}: ${asStr(device[k])}`);
  }
  return lines.join("\n");
}

function renderPorts(ports: Row[]): string {
  if (!ports.length) return "No ports.";
  const lines = [`${ports.length} port(s):`];
  for (const p of ports) {
    lines.push(
      `  ${asStr(p.ifName)}  admin=${asStr(p.ifAdminStatus)} oper=${asStr(p.ifOperStatus)}` +
        `  errIn=${asStr(p.ifInErrors)} errOut=${asStr(p.ifOutErrors)}  ${asStr(p.ifDescr)}`,
    );
  }
  return lines.join("\n");
}

function renderPort(port: Row | null): string {
  if (!port) return "Port not found.";
  const lines = [`Port ${asStr(port.ifName)} [${asStr(port.port_id)}] on device ${asStr(port.device_id)}`];
  for (const k of ["ifAlias", "ifAdminStatus", "ifOperStatus", "ifSpeed", "ifInErrors", "ifOutErrors", "ifInOctets", "ifOutOctets"]) {
    if (port[k] !== undefined) lines.push(`  ${k}: ${asStr(port[k])}`);
  }
  return lines.join("\n");
}

function renderPortHealth(metric: HealthMetric, limit: number, top: Row[]): string {
  if (!top.length) return "No ports.";
  const lines = [`Top ${Math.min(limit, top.length)} ports by ${metric}:`];
  for (const p of top) {
    const util = num(p.ifSpeed) ? ((num(p.ifInOctets) + num(p.ifOutOctets)) / num(p.ifSpeed)).toFixed(4) : "-";
    lines.push(
      `  dev=${asStr(p.device_id)} ${asStr(p.ifName)}  errIn=${asStr(p.ifInErrors)} errOut=${asStr(p.ifOutErrors)} util=${util}`,
    );
  }
  return lines.join("\n");
}

function renderAlerts(alerts: Row[]): string {
  if (!alerts.length) return "No alerts.";
  const lines = [`${alerts.length} alert(s):`];
  for (const a of alerts) {
    lines.push(
      `  [${asStr(a.id)}] device=${asStr(a.hostname ?? a.device_id)} state=${asStr(a.state)} sev=${asStr(a.severity)}  ${asStr(a.rule ?? a.name)}`,
    );
  }
  return lines.join("\n");
}

function renderAlert(alert: Row | null): string {
  if (!alert) return "Alert not found.";
  const lines = [`Alert ${asStr(alert.id)}`];
  for (const k of ["hostname", "device_id", "rule", "name", "severity", "state", "timestamp", "alerted"]) {
    if (alert[k] !== undefined) lines.push(`  ${k}: ${asStr(alert[k])}`);
  }
  return lines.join("\n");
}

function renderLogs(label: string, logs: Row[]): string {
  if (!logs.length) return `No ${label} entries.`;
  const lines = [`${logs.length} ${label} entr${logs.length === 1 ? "y" : "ies"}:`];
  for (const l of logs) {
    const ts = asStr(l.datetime ?? l.timestamp ?? l.time_logged);
    const dev = asStr(l.hostname ?? l.device_id);
    const msg = asStr(l.message ?? l.details ?? l.rule);
    lines.push(`  ${ts}  device=${dev}  ${msg}`);
  }
  return lines.join("\n");
}

export interface CliDeps {
  out: (s: string) => void;
  err: (s: string) => void;
  makeClient: () => LibreNmsClient;
  serve: () => Promise<void>;
}

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error));
    deps.err("");
    deps.err(HELP);
    return 2;
  }

  if (parsed.kind === "help") {
    deps.out(HELP);
    return 0;
  }
  if (parsed.kind === "version") {
    deps.out(VERSION);
    return 0;
  }
  if (parsed.kind === "mcp") {
    await deps.serve();
    return 0;
  }

  const client = deps.makeClient();
  try {
    switch (parsed.kind) {
      case "status": {
        const r = await client.get<{ system?: Row[] }>("/system");
        const system = r.system?.[0] ?? null;
        deps.out(parsed.json ? JSON.stringify({ system }, null, 2) : system ? renderSystem(system) : "No system data.");
        return system ? 0 : 1;
      }
      case "devices-list": {
        const path = parsed.type ? `/devices?type=${encodeURIComponent(parsed.type)}` : "/devices";
        const r = await client.get<{ devices?: Row[] }>(path);
        const devices = r.devices ?? [];
        deps.out(parsed.json ? JSON.stringify({ devices }, null, 2) : renderDevices(devices));
        return 0;
      }
      case "devices-get": {
        const r = await client.get<{ devices?: Row[] }>(`/devices/${encodeURIComponent(parsed.hostname)}`);
        const device = r.devices?.[0] ?? null;
        deps.out(parsed.json ? JSON.stringify({ device }, null, 2) : renderDevice(device));
        return device ? 0 : 1;
      }
      case "ports-list": {
        const columns = "ifName,ifAdminStatus,ifOperStatus,ifInErrors,ifOutErrors,ifSpeed,ifDescr";
        const r = await client.get<{ ports?: Row[] }>(
          `/devices/${encodeURIComponent(parsed.hostname)}/ports?columns=${columns}`,
        );
        const ports = r.ports ?? [];
        deps.out(parsed.json ? JSON.stringify({ ports }, null, 2) : renderPorts(ports));
        return 0;
      }
      case "ports-get": {
        const r = await client.get<{ port?: Row[] }>(`/ports/${encodeURIComponent(parsed.portId)}`);
        const port = r.port?.[0] ?? null;
        deps.out(parsed.json ? JSON.stringify({ port }, null, 2) : renderPort(port));
        return port ? 0 : 1;
      }
      case "ports-health": {
        const columns = "device_id,ifName,ifInErrors,ifOutErrors,ifSpeed,ifInOctets,ifOutOctets";
        const r = await client.get<{ ports?: Row[] }>(`/ports?columns=${columns}`);
        const ports = r.ports ?? [];
        const metric = parsed.metric;
        const sorted = ports.slice().sort((a, b) => {
          if (metric === "errors_in") return num(b.ifInErrors) - num(a.ifInErrors);
          if (metric === "errors_out") return num(b.ifOutErrors) - num(a.ifOutErrors);
          const aUtil = num(a.ifSpeed) ? (num(a.ifInOctets) + num(a.ifOutOctets)) / num(a.ifSpeed) : 0;
          const bUtil = num(b.ifSpeed) ? (num(b.ifInOctets) + num(b.ifOutOctets)) / num(b.ifSpeed) : 0;
          return bUtil - aUtil;
        });
        const top = sorted.slice(0, parsed.limit);
        deps.out(
          parsed.json
            ? JSON.stringify({ metric, limit: parsed.limit, top }, null, 2)
            : renderPortHealth(metric, parsed.limit, top),
        );
        return 0;
      }
      case "alerts-list": {
        const path =
          parsed.state !== undefined ? `/alerts?state=${encodeURIComponent(parsed.state)}` : "/alerts";
        const r = await client.get<{ alerts?: Row[] }>(path);
        const alerts = r.alerts ?? [];
        deps.out(parsed.json ? JSON.stringify({ alerts }, null, 2) : renderAlerts(alerts));
        return 0;
      }
      case "alerts-get": {
        const r = await client.get<{ alerts?: Row[] }>(`/alerts/${encodeURIComponent(parsed.id)}`);
        const alert = r.alerts?.[0] ?? null;
        deps.out(parsed.json ? JSON.stringify({ alert }, null, 2) : renderAlert(alert));
        return alert ? 0 : 1;
      }
      case "alerts-history": {
        const path =
          parsed.deviceId !== undefined
            ? `/logs/alertlog/${encodeURIComponent(parsed.deviceId)}?limit=${encodeURIComponent(parsed.limit)}`
            : `/logs/alertlog?limit=${encodeURIComponent(parsed.limit)}`;
        const r = await client.get<{ logs?: Row[] }>(path);
        const logs = r.logs ?? [];
        deps.out(parsed.json ? JSON.stringify({ count: logs.length, logs }, null, 2) : renderLogs("alert-log", logs));
        return 0;
      }
      case "events-list": {
        const path =
          parsed.deviceId !== undefined
            ? `/logs/eventlog/${encodeURIComponent(parsed.deviceId)}?limit=${encodeURIComponent(parsed.limit)}`
            : `/logs/eventlog?limit=${encodeURIComponent(parsed.limit)}`;
        const r = await client.get<{ logs?: Row[] }>(path);
        const logs = r.logs ?? [];
        deps.out(parsed.json ? JSON.stringify({ count: logs.length, logs }, null, 2) : renderLogs("event-log", logs));
        return 0;
      }
    }
  } catch (error) {
    // Reuse the security redactor so a leaked token never reaches the terminal,
    // and surface validate.ts's ValidationError as a usage error (exit 2).
    if (error instanceof ValidationError) {
      deps.err(redact(error.message) as string);
      return 2;
    }
    deps.err(redact(boundaryErrorMessage(error)) as string);
    return 1;
  }
  return 0;
}

// True when this module is the process entrypoint. process.argv[1] is often a
// symlink (npm installs the bin as a link); resolve it before comparing.
const isEntrypoint = (() => {
  const arg = process.argv[1];
  if (typeof arg !== "string") return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(arg)).href;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  run(process.argv.slice(2), {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    makeClient: () => new LibreNmsClient(resolveConfig(process.env)),
    serve,
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${redact(boundaryErrorMessage(error)) as string}\n`);
      process.exitCode = 1;
    });
}
