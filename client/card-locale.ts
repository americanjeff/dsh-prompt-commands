/**
 * dsh-prompt-commands — the settings card's locale dictionaries (client).
 *
 * The key union merges into the host's `LocaleNamespaceMap` below — the
 * single declaration that types the pipeline: `ctx.locale.register` checks
 * the dictionaries against it, and the slot entry's `locale:` option puts
 * the framework-synthesized `t` seat on the card's props, typed to the same
 * union. The `LocaleDictOf` import is load-bearing: under NodeNext a module
 * augmentation is honored only when the augmenting file also imports the
 * augmented module.
 */

import type { LocaleDictOf } from "@deepseek-ai/dsh-client-ui-slots";

export const NAMESPACE = "prompt-commands";

export const LOCALE_KEYS = {
  unavailable: "unavailable",
  promptDirs: "promptDirs",
  promptDirsHint: "promptDirsHint",
  invalidDirs: "invalidDirs",
  noDirs: "noDirs",
  inheritRoute: "inheritRoute",
  inheritModel: "inheritModel",
  invalidText: "invalidText",
  subagentProvider: "subagentProvider",
  subagentProviderHint: "subagentProviderHint",
  subagentModel: "subagentModel",
  subagentModelHint: "subagentModelHint",
  subagentMaxTokens: "subagentMaxTokens",
  subagentMaxTokensHint: "subagentMaxTokensHint",
  invalidTokens: "invalidTokens",
  subagentEffort: "subagentEffort",
  subagentEffortHint: "subagentEffortHint",
  invalidEffort: "invalidEffort",
  lang: "lang",
  langHint: "langHint",
  invalidLang: "invalidLang",
  overridden: "overridden",
  reset: "reset",
  save: "save",
  saving: "saving",
  saveFailed: "saveFailed",
  readOnly: "readOnly",
} as const;

export type LocaleKey = (typeof LOCALE_KEYS)[keyof typeof LOCALE_KEYS];

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** The prompt-commands settings card's copy (client/card-locale.ts). */
    "prompt-commands": LocaleKey;
  }
}

export const en: LocaleDictOf<"prompt-commands"> = {
  unavailable: "This plugin is not loaded, so it cannot be configured right now.",
  promptDirs: "Extra template directories",
  promptDirsHint: "Comma-separated absolute paths; non-recursive, .md files only. These roots win same-named templates over the global root.",
  invalidDirs: "Enter comma-separated directory paths, or leave empty for the default roots only.",
  noDirs: "Default roots only",
  inheritRoute: "Session route",
  inheritModel: "Session model",
  invalidText: "Enter a value, or leave empty to inherit.",
  subagentProvider: "Subagent provider",
  subagentProviderHint: "Route for `execution: subagent` templates; leave empty to inherit the session's route.",
  subagentModel: "Subagent model",
  subagentModelHint: "Leave empty to inherit the session's model.",
  subagentMaxTokens: "Subagent max tokens",
  subagentMaxTokensHint: "Positive whole number; leave empty to inherit.",
  invalidTokens: "Enter a positive whole number, or leave empty to inherit.",
  subagentEffort: "Subagent effort",
  subagentEffortHint: "none, low, medium, or high — mapped onto the child route's ladder; leave empty for its default.",
  invalidEffort: "Enter none, low, medium, or high, or leave empty to inherit.",
  lang: "Plugin copy language",
  langHint: "en or zh — the plugin's own strings (results, notices); template content is unaffected.",
  invalidLang: "Enter en or zh.",
  overridden: "custom",
  reset: "Reset to default",
  save: "Save",
  saving: "Saving…",
  saveFailed: "The deployment did not accept these values; they were left for you to correct.",
  readOnly: "This deployment stores settings read-only.",
};

export const zh: LocaleDictOf<"prompt-commands"> = {
  unavailable: "该插件当前未加载，暂时无法配置。",
  promptDirs: "额外模板目录",
  promptDirsHint: "逗号分隔的绝对路径；不递归，仅 .md 文件。这些目录中的同名模板优先于全局根目录。",
  invalidDirs: "请输入逗号分隔的目录路径，或留空表示仅使用默认根目录。",
  noDirs: "仅默认根目录",
  inheritRoute: "会话路由",
  inheritModel: "会话模型",
  invalidText: "请输入值，或留空表示继承。",
  subagentProvider: "子代理 provider",
  subagentProviderHint: "execution: subagent 模板使用的路由；留空则继承会话路由。",
  subagentModel: "子代理模型",
  subagentModelHint: "留空则继承会话模型。",
  subagentMaxTokens: "子代理最大 token 数",
  subagentMaxTokensHint: "正整数；留空则继承。",
  invalidTokens: "请输入正整数，或留空表示继承。",
  subagentEffort: "子代理推理强度",
  subagentEffortHint: "none、low、medium 或 high——映射到子路由的推理档位；留空则使用其默认值。",
  invalidEffort: "请输入 none、low、medium 或 high，或留空表示继承。",
  lang: "插件文案语言",
  langHint: "en 或 zh——仅影响插件自身的固定文案（结果、通知）；模板内容不受影响。",
  invalidLang: "请输入 en 或 zh。",
  overridden: "已覆盖",
  reset: "恢复默认",
  save: "保存",
  saving: "保存中…",
  saveFailed: "本部署没有接受这些值，已保留供你修改。",
  readOnly: "本部署的设置为只读。",
};