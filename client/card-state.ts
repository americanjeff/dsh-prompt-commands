/**
 * dsh-prompt-commands — the settings card's field specs (pure, framework
 * neutral, no imports).
 *
 * The card's staging model is the stock `SettingsFormModel`: a card STAGES
 * what the user types and writes it only on save, one revision-fenced
 * mutation per save. These specs say how each stored value renders as
 * control text and how control text parses back to a write; a draft a field
 * does not accept is `undefined` — the save blocks rather than the draft
 * being dropped.
 *
 * The config fields are FLAT (the stock model addresses top-level keys of
 * the served section only): promptDirs, subagentProvider, subagentModel,
 * subagentMaxTokens, subagentEffort, lang — the same keys lib/config.js
 * declares.
 */

/** The section shape the card edits (absent key = inherit the composition base). */
export interface CardSection {
  promptDirs?: string[];
  subagentProvider?: string;
  subagentModel?: string;
  subagentMaxTokens?: number;
  subagentEffort?: string;
  lang?: string;
}

/** The write one field's staged text performs when the card is saved. */
export type FieldWrite = { kind: "set"; value: unknown } | { kind: "clear" };

/** How one section field converts between its stored value and its draft text. */
export interface FieldSpec {
  field: string;
  format: (value: unknown) => string;
  parse: (text: string) => FieldWrite | undefined;
}

const EFFORT_LEVELS = ["none", "low", "medium", "high"] as const;

/** A comma-separated directory-list field. An empty draft clears the field. */
function dirsSpec(field: keyof CardSection & string): FieldSpec {
  return {
    field,
    format: (value) => (Array.isArray(value) ? value.join(", ") : ""),
    parse: (text) => {
      const trimmed = text.trim();
      if (trimmed === "") return { kind: "clear" };
      const parts = trimmed.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
      if (parts.length === 0) return undefined;
      return { kind: "set", value: parts };
    },
  };
}

/** A free-text field. An empty draft clears the field (re-inherit). */
function textSpec(field: keyof CardSection & string): FieldSpec {
  return {
    field,
    format: (value) => (typeof value === "string" ? value : ""),
    parse: (text) => {
      const trimmed = text.trim();
      if (trimmed === "") return { kind: "clear" };
      return { kind: "set", value: trimmed };
    },
  };
}

/** A positive whole-number field. An empty draft clears the field. */
function tokensSpec(field: keyof CardSection & string): FieldSpec {
  return {
    field,
    format: (value) => (typeof value === "number" ? String(value) : ""),
    parse: (text) => {
      const trimmed = text.trim();
      if (trimmed === "") return { kind: "clear" };
      if (!/^[0-9]+$/.test(trimmed)) return undefined;
      const value = Number(trimmed);
      return Number.isSafeInteger(value) && value > 0 ? { kind: "set", value } : undefined;
    },
  };
}

/** An enum field over `allowed`. An empty draft clears the field. */
function enumSpec(field: keyof CardSection & string, allowed: readonly string[]): FieldSpec {
  return {
    field,
    format: (value) => (typeof value === "string" ? value : ""),
    parse: (text) => {
      const trimmed = text.trim();
      if (trimmed === "") return { kind: "clear" };
      return allowed.includes(trimmed) ? { kind: "set", value: trimmed } : undefined;
    },
  };
}

/**
 * The card's field specs, in the order the card renders its rows — the same
 * order lib/config.js declares the schema fields.
 */
export const FIELD_SPECS: readonly FieldSpec[] = [
  dirsSpec("promptDirs"),
  textSpec("subagentProvider"),
  textSpec("subagentModel"),
  tokensSpec("subagentMaxTokens"),
  enumSpec("subagentEffort", EFFORT_LEVELS),
  enumSpec("lang", ["en", "zh"]),
];