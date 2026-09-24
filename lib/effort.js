/**
 * Coarse reasoning-effort levels for prompt templates.
 *
 * A template declares `effort: low | medium | high`; at spawn time the level
 * is mapped onto one concrete rung of the resolved child route's advertised
 * effort ladder — `low` → lowest rung, `medium` → middle rung, `high` →
 * highest rung, rungs that switch reasoning off excluded. The coarse set is
 * deliberately small and stable; the concrete rungs are adapter-owned opaque
 * ids that vary per deployment (one route may offer
 * `off · low · medium · xhigh` while another offers `low · high`), so no
 * concrete id is ever named here.
 *
 * Pure: `resolveEffort` takes the runtime's model-info lookup as a parameter.
 *
 * @module dsh-prompt-commands/lib/effort
 */

/** The coarse effort levels a template may declare. */
export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high'])

/**
 * Effort ids that switch reasoning OFF rather than lowering it. Excluded
 * from the mapping pool: `low` means "cheapest reasoning the route offers",
 * not "no reasoning at all".
 */
const DISABLED_EFFORT_IDS = new Set(['off', 'none', 'no', 'disabled'])

/**
 * Map one coarse level onto the rungs of one route's advertised effort
 * ladder.
 *
 * @param {'low' | 'medium' | 'high'} coarse - the declared level.
 * @param {ReadonlyArray<string>} effortIds - the route's advertised effort ids, in adapter order (ascending effort).
 * @returns {string | undefined} the mapped concrete effort id, or
 *   `undefined` when the ladder has no usable rung (empty, or only
 *   reasoning-off rungs).
 */
export function mapEffort(coarse, effortIds) {
  const pool = effortIds.filter((id) => !DISABLED_EFFORT_IDS.has(String(id).toLowerCase()))
  if (pool.length === 0) return undefined
  switch (coarse) {
    case 'low':
      return pool[0]
    case 'medium':
      return pool[Math.floor((pool.length - 1) / 2)]
    case 'high':
      return pool[pool.length - 1]
  }
}

/**
 * Resolve one coarse level to the concrete effort id of one exact
 * provider/model route via the runtime's model-info lookup.
 *
 * @param {'low' | 'medium' | 'high'} coarse - the declared level.
 * @param {{ provider: string, model: string, llm: { resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ reasoning?: { efforts?: readonly { id: string }[] } }> }, signal?: AbortSignal }} options
 * @returns {Promise<string | undefined>} the concrete effort id, or
 *   `undefined` when the route cannot be resolved or advertises no usable
 *   rung (the caller warns and spawns without an effort).
 */
export async function resolveEffort(coarse, { provider, model, llm, signal }) {
  try {
    const info = await llm.resolveModelInfo(provider, model, signal)
    const ladder = (info.reasoning?.efforts ?? []).map((effort) => effort.id)
    return mapEffort(coarse, ladder)
  } catch {
    return undefined
  }
}
