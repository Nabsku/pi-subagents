# Native Herdr subagent lifecycle event

`pi-subagents` publishes visibility-only child lifecycle records on Pi's in-process extension event bus when, and only when, the explicitly selected terminal backend is `herdr`.

Channel: `herdr:subagent`

Version 1 payload:

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `1` | Contract version. |
| `kind` | `registered \| state \| released` | Registration, state transition, or exact-once release. |
| `runId` | string, 1–256 chars | Stable pi-subagents run identity. |
| `childIndex` | integer, 0–1,000,000 | Zero-based child identity within the run. |
| `generation` | positive integer | Replacement/retry generation for the same run and child index. |
| `sequence` | positive integer | Strictly increasing per run and child index, including replacements. |
| `timestamp` | number | Unix epoch milliseconds assigned at emission. |
| `agent` | string, 1–128 chars | Display/agent name. |
| `state` | `starting \| running \| completed \| failed \| stopped` | Canonical projected child state. |
| `terminal` | object | Exact published Herdr `workspaceId`, `tabId`, `paneId`, and optional `terminalId`. Each identity component is at most 256 chars. |

Ordering for a published child is `registered(starting)`, zero or more deduplicated `state` events, then one `released` event. Terminal identity is never emitted before the Herdr terminal handle and validated child process identity have both been published. A launch that fails before publication emits nothing.

Consumers must key records by `(runId, childIndex)`, reject unknown versions, order by `sequence`, and use `generation` to distinguish replacement attempts. Delivery is best-effort and visibility-only; this contract provides no stop, retry, steering, capability, or acknowledgement transport.

The schema intentionally excludes prompts, model output, filesystem paths, argv, environment, secrets, token usage, process credentials, and capabilities. Default/headless execution does not emit this event and does not probe Herdr.
