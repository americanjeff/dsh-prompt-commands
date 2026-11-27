/**
 * dsh-prompt-commands — the plugin's settings card (browser bundle).
 *
 * One entry in the host's `plugins.bundle.config` slot under this bundle's
 * package name (the plugin-manager's bundle detail page renders it in its
 * configuration section), gated through `configForms.whileServed` on the
 * entry id `prompt-commands` (client.tsx). No card chrome of its own — the
 * page draws the title/one-liner, the entry renders as the host's stock
 * `SettingsForm` frame over `SettingsValueField` rows. Every field of the
 * card is a stock value field (no booleans), so no row CSS is re-declared.
 *
 * The staged-edit model is the stock `SettingsFormModel` (per-field Reset,
 * revision-fenced save, discard-on-unmount). A save writes each flat field
 * the specs stage — the same keys lib/config.js declares, every one
 * `.volatile()`, so the host commits the save into the running plugin
 * without a re-apply.
 */

import type { ReactElement } from "react";
import {
  type SettingsFieldState,
  type SettingsFormActions,
  type SettingsFormShell,
  SettingsForm,
  SettingsFormModel,
  SettingsValueField,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { ConfigForm } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { SnapshotStore } from "@deepseek-ai/dsh-client-store";
// The `plugins.bundle.config` SlotMap declaration (keyed on the bundle's
// package name) — type-only; the runtime slot is declared by the host's
// plugin-manager page.
import type {} from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
// The LocaleNamespaceMap merge that puts `prompt-commands` on the map —
// the module's augmentation applies as soon as it is in the program.
import type {} from "./card-locale.js";
import { type CardSection, type FieldSpec, FIELD_SPECS } from "./card-state.js";

/** What the card renders: the stock form shell + one control state per field. */
export interface PromptCommandsCardState extends SettingsFormShell {
  promptDirs: SettingsFieldState;
  subagentProvider: SettingsFieldState;
  subagentModel: SettingsFieldState;
  subagentMaxTokens: SettingsFieldState;
  subagentEffort: SettingsFieldState;
  lang: SettingsFieldState;
}

/** The registration-side face the card's slot entry injects. */
export interface PromptCommandsCardFace extends SettingsFormActions {
  hooks: {
    /** Card snapshot bound by the renderer as `usePromptCommandsCard`. */
    promptCommandsCard: SnapshotStore<PromptCommandsCardState>;
  };
}

/** Props the renderer binds for the card (the stock card props pattern). */
export type PromptCommandsCardProps =
  PropsRuntime<"plugins.bundle.config"> &
  PropsLocale<"prompt-commands"> &
  InjectFace<PromptCommandsCardFace>;

/**
 * Bridges the `prompt-commands` scope onto the stock staged form — the same
 * `SettingsFormModel` the host's own settings pages run. Supplies the field
 * specs and the projection the card reads through its bound selector.
 */
export class CardController {
  private readonly form: SettingsFormModel<CardSection>;
  private readonly store: SnapshotStore<PromptCommandsCardState>;

  constructor(scope: ConfigForm<CardSection>, specs: readonly FieldSpec[] = FIELD_SPECS) {
    this.form = new SettingsFormModel(scope, [...specs]);
    this.store = this.form.bind(() => this.projection());
  }

  /** The card's snapshot: the shared shell flags + one control state per field. */
  private projection(): PromptCommandsCardState {
    return {
      ...this.form.shell(),
      promptDirs: this.form.field("promptDirs"),
      subagentProvider: this.form.field("subagentProvider"),
      subagentModel: this.form.field("subagentModel"),
      subagentMaxTokens: this.form.field("subagentMaxTokens"),
      subagentEffort: this.form.field("subagentEffort"),
      lang: this.form.field("lang"),
    };
  }

  /** The face the card's slot registration injects. */
  inject(): PromptCommandsCardFace {
    return {
      hooks: { promptCommandsCard: this.store },
      ...this.form.actions(),
    };
  }

  /** Release the form's scope subscription (the client entry disposes on unmount). */
  dispose(): void {
    this.form.dispose();
  }
}

/**
 * Render the card: the stock settings form over this plugin's six rows — the
 * same shape the host's Shell settings page renders.
 *
 * @param props - locale copy, the card snapshot (via the bound selector), and the form actions.
 */
export function PromptCommandsCard(props: PromptCommandsCardProps): ReactElement {
  const { t } = props;
  const state = props.usePromptCommandsCard((snapshot) => snapshot);
  const disabled = !state.writable;
  const valueField = (
    id: string,
    label: string,
    hint: string,
    field: SettingsFieldState,
    invalidLabel: string,
    placeholder?: string,
    numeric = false,
  ) => (
    <SettingsValueField
      id={id}
      label={label}
      hint={hint}
      overriddenLabel={t("overridden")}
      resetLabel={t("reset")}
      invalidLabel={invalidLabel}
      numeric={numeric}
      disabled={disabled}
      {...(placeholder === undefined ? {} : { placeholder })}
      {...field}
      onEdit={(text) => props.edit(id, text)}
      onReset={() => props.resetField(id)}
    />
  );
  return (
    <div data-dsh-prompt-commands="settings-card">
    <SettingsForm
      labels={{
        unavailable: t("unavailable"),
        readOnly: t("readOnly"),
        saveFailed: t("saveFailed"),
        save: t("save"),
        saving: t("saving"),
      }}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      {valueField("promptDirs", t("promptDirs"), t("promptDirsHint"), state.promptDirs, t("invalidDirs"), t("noDirs"))}
      {valueField("subagentProvider", t("subagentProvider"), t("subagentProviderHint"), state.subagentProvider, t("invalidText"), t("inheritRoute"))}
      {valueField("subagentModel", t("subagentModel"), t("subagentModelHint"), state.subagentModel, t("invalidText"), t("inheritModel"))}
      {valueField("subagentMaxTokens", t("subagentMaxTokens"), t("subagentMaxTokensHint"), state.subagentMaxTokens, t("invalidTokens"), undefined, true)}
      {valueField("subagentEffort", t("subagentEffort"), t("subagentEffortHint"), state.subagentEffort, t("invalidEffort"))}
      {valueField("lang", t("lang"), t("langHint"), state.lang, t("invalidLang"))}
    </SettingsForm>
    </div>
  );
}