/**
 * Client build face: bundles client/client.tsx into dist/dsh/client.js —
 * the dsh clientBundle closure-factory shape (the dsh-image-settings
 * pattern: plain tsdown, no CSS pipeline — the card renders stock
 * primitives only).
 *
 * The node half is plain JS at the repo root (main: ./index.js — no tsc).
 *
 * The bundle hands itself to the web shell's module loader —
 * `window.__ModuleLoader__.load({ id, factory: (require) => { …CJS… } })` —
 * and the injected `require` resolves externals through the loader's module
 * table. Only baseline table rows may be required (EXTERNALS below);
 * anything else MUST inline into the bundle. The bundle's runtime requires
 * stay within this set (react + react/jsx-runtime, and
 * @deepseek-ai/dsh-client-ui-primitives for the stock settings-form
 * components; every other dsh import is type-only and erased, and
 * card-state.ts inlines).
 */
import { isBuiltin } from "node:module";
import type { UserConfig } from "tsdown";

/** The row id the bundle registers under (== package name). */
const ID = "dsh-prompt-commands";

/**
 * Baseline module-table rows a client bundle may require without declaring
 * them (PLATFORM_MODULES from the web shell's platform.ts).
 */
const EXTERNALS = new Set([
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
]);

export default [
  {
    name: "dsh-prompt-commands/client",
    entry: { client: "client/client.tsx" },
    outDir: "dist/dsh",
    format: "cjs",
    platform: "browser",
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: (specifier: string) => EXTERNALS.has(specifier),
      alwaysBundle: (specifier: string) =>
        !isBuiltin(specifier) && !EXTERNALS.has(specifier),
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    outputOptions: {
      entryFileNames: "client.js",
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: "return module.exports; } });",
      intro: "var module = { exports: {} }; var exports = module.exports;",
    },
  },
] satisfies UserConfig[];