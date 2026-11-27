/**
 * dsh-prompt-commands — dsh client half (browser bundle).
 *
 * The plugin's settings form: one entry in the host's `plugins.bundle.config`
 * slot under this bundle's package name (the plugin-manager's bundle detail
 * page renders it in its configuration section), staged-edit save over the
 * config form the entry is served through (card.tsx). Registration is gated
 * through `configForms.whileServed` on the plugin's namespace — the entry
 * `id:` in dsh.cordis.yml (`prompt-commands`) — so the card shows wherever
 * the section serves this deployment and nowhere the Host does not. The slot
 * KEY, by contrast, is the package name (`dsh-prompt-commands`).
 *
 * The form carries no card chrome of its own — the bundle's page draws the
 * title and one-liner — and renders the host's own stock settings form, its
 * copy riding this plugin's own locale namespace (card-locale.ts), registered
 * with the `locale:` slot option so the framework hands the form a typed `t`.
 */

import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { ConfigForm } from "@deepseek-ai/dsh-client-ui-settings/client";
// The module merge that puts `slots` on the cordis Context (the renderer
// owns the SlotRegistry service) — type-only.
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
// The module merge that puts `locale` on the cordis Context — type-only.
import type {} from "@deepseek-ai/dsh-client-locale/client";
// The SlotMap declaration of `plugins.bundle.config` + its owner props —
// type-only; the runtime slot is declared by the host's plugin-manager page.
import type {} from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import { CardController, PromptCommandsCard } from "./card.js";
import { en, NAMESPACE, zh } from "./card-locale.js";
import type { CardSection } from "./card-state.js";

export const name = "dsh-prompt-commands";
// The profile entry id the settings model keys by — this bundle's entry
// `id:` in dsh.cordis.yml, which differs from the package name here.
const ENTRY_ID = "prompt-commands";
// Required services (cordis fiber inject): the slot registry (the renderer),
// the settings scope (the ui-settings base), and the locale runtime (the
// card's dictionary registration + the framework-synthesized `t` seat).
export const inject = ["slots", "configForms", "locale"];

/** Register the settings card once the shell declares the slot. */
export function apply(ctx: ClientContext): void {
  // One config form per plugin activation. The shared describe mirror
  // reloads on settings changes made anywhere — this page, another tab, or
  // an out-of-band edit of the profile's patch.
  const scope: ConfigForm<CardSection> = ctx.configForms.get<CardSection>(ENTRY_ID);

  ctx.effect(
    () => ctx.locale.register(NAMESPACE, { en, zh }),
    "prompt-commands: settings card dictionary",
  );
  const cardController = new CardController(scope);
  // The stock model subscribes to the scope; release it with the plugin.
  ctx.effect(() => () => cardController.dispose(), "prompt-commands: form subscription");
  ctx.effect(
    () =>
      ctx.configForms.whileServed([ENTRY_ID], () =>
        ctx.slots.inject("plugins.bundle.config", () =>
          ctx.slots.register(
            {
              name: "plugins.bundle.config",
              key: name,
              locale: NAMESPACE,
              registrant: name,
              inject: () => cardController.inject(),
            },
            PromptCommandsCard,
          ),
        ),
      ),
    "prompt-commands: settings card (while the Host serves the section)",
  );
}