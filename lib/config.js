/**
 * The plugin's settings `Config` schema (the dsh 0.1.7+ settings model):
 * exported from the node half, validated by the loader against the entry's
 * `config:` block, and edited live by the client half's settings card
 * (client/card.tsx) through `configForms`.
 *
 * All fields are `.volatile()`: a card save commits in place into the
 * running fiber's refs and emits `loader/volatile-update` — apply() re-reads
 * the refs (promptDirs re-syncs the watch roots; lang / the subagent route
 * fields are read per invocation) without a re-apply.
 *
 * The fields are deliberately FLAT — the stock `SettingsFormModel` the card
 * stages over addresses top-level keys of the served section only, so the
 * former nested `subagent:` block became `subagentProvider` / `subagentModel`
 * / `subagentMaxTokens` / `subagentEffort`. No profile shipped a nested
 * block, so nothing migrates.
 *
 * @module dsh-prompt-commands/lib/config
 */

import z from '@deepseek-ai/schemastery'
import { EFFORT_LEVELS } from './effort.js'

/**
 * The write gate for the entry's `config:` block.
 *
 * - `promptDirs` defaults to `[]` (the composition base: no extra roots).
 * - The subagent route fields carry no default: an absent field re-inherits
 *   (the session's route, or the child's route default for effort).
 * - `lang` defaults to `'en'`.
 */
export const Config = z.object({
  promptDirs: z.array(z.string()).default([]).volatile(),
  subagentProvider: z.string().volatile(),
  subagentModel: z.string().volatile(),
  subagentMaxTokens: z.number().step(1).min(1).volatile(),
  subagentEffort: z.union(EFFORT_LEVELS).volatile(),
  lang: z.union(['en', 'zh']).default('en').volatile(),
})