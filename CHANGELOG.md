# Changelog

## [0.1.2] - 2026-09-28

- Added: `lang: en|zh` row config — the plugin's own UI copy (fallback description, result texts, subagent notices) is localizable; template content is user-written and unaffected
- Added: `effort: none` level for subagent templates — maps onto the child route's reasoning-off rung, degrading to the lowest rung on routes without one
- Added: MIT `LICENSE`; row title/description localized through `locale/en.json` / `locale/zh.json` (follows the browser locale)
- Changed: e2e re-validated against dsh 0.2.0-rc.1; websocket readiness gate now reads the raw CDP handshake (status 101) instead of the unreliable Playwright ws `open` event

## [0.1.1] - 2026-09-24

- Fixed: subagent templates declaring `effort` errored at spawn instead of starting the subagent
