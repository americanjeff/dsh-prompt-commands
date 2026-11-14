# Changelog

## [0.3.0] - 2026-11-13

- Works with the dsh 0.2.2 host line: the `startActivation` spec flattened its task options — `prompt`, `parent`, and `agentOptions` moved from the nested `request` object onto the spec itself (dsh commit `575606a`, first shipped in 0.2.2-rc.2). On a 0.2.2 host, plugin 0.2.0 failed subagent templates with `Failed to start the <name> subagent: Cannot read properties of undefined (reading 'id')` (the service read `spec.parent.id` on the now-missing parent).
- Earlier hosts (0.2.1) no longer satisfy the compatibility floor: on them `execution: subagent` templates fail the same way — use plugin 0.2.x there.

## [0.2.0] - 2026-10-18

- Works with the dsh 0.2.1 host line: the subagent seam moved from `subagents.start(provider, request)` to `subagents.startActivation(spec)`, where the spec carries `provider`, `label`, `signal`, and `delivery` and the nested `request` no longer takes label or signal. The plugin spawns with `delivery: 'caller'` — the same semantics as the old seam, where the caller (not the harness) reports the outcome; the plugin keeps delivering its own localized notices.
- Earlier hosts (0.2.0) no longer satisfy the compatibility floor: on them `execution: subagent` templates fail with `subagents.start is not a function`.

## [0.1.2] - 2026-09-28

- Added: `lang: en|zh` row config — the plugin's own UI copy (fallback description, result texts, subagent notices) is localizable; template content is user-written and unaffected
- Added: `effort: none` level for subagent templates — maps onto the child route's reasoning-off rung, degrading to the lowest rung on routes without one
- Added: MIT `LICENSE`; row title/description localized through `locale/en.json` / `locale/zh.json` (follows the browser locale)
- Changed: e2e re-validated against dsh 0.2.0-rc.1; websocket readiness gate now reads the raw CDP handshake (status 101) instead of the unreliable Playwright ws `open` event

## [0.1.1] - 2026-09-24

- Fixed: subagent templates declaring `effort` errored at spawn instead of starting the subagent
