# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- README rewritten to the OSS adoption-upgrade standard: WHAT/WHY/HOW lede with the write-gate differentiator on the first screen, an honest work-in-progress status note, centered badges, a prominent [website](https://lidless.dev/librenms-mcp) link, a keyword-rich "What it does" section, a copy-paste MCP client config, a verified `npx` quickstart, the real 13-tool list (10 reads, 3 confirm-gated safe writes) generated from `mcp-server.ts`, and "Why not just point an agent at the LibreNMS API?" plus "What librenms-mcp is not" sections.

### Added
- `LIBRENMS_REQUEST_TIMEOUT_MS` env var for per-request HTTP timeouts (default `30000` ms, minimum `1000` ms); hung requests now fail instead of waiting indefinitely.
- Maintainer-health files: `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, GitHub issue templates (`bug.yml`, `feature.yml`, `config.yml`), and a pull-request template with a no-PII / content-guard checkbox.

## [0.2.0]

### Added
- 10 read tools (`librenms_status`, `librenms_list_devices`, `librenms_get_device`, `librenms_list_ports`, `librenms_get_port`, `librenms_port_health`, `librenms_list_alerts`, `librenms_get_alert`, `librenms_alert_history`, `librenms_event_log`).
- 3 confirm-gated safe-write tools (`librenms_ack_alert`, `librenms_unmute_alert`, `librenms_set_maintenance`), each requiring an explicit `confirm: true`.
- Three-tier write gating (open reads, confirm-gated safe writes, destructive tier deferred), TypeBox input validation on every tool call, and token redaction in all log and error output.
