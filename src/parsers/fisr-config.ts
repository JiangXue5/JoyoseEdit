// booster_config.params.game_booster.fisr_config is the strategy router that
// says, for a given game, which backend handles FI / SR / FISR / RE. Observed
// shapes:
//
//   Mi 15 / 15 Pro:
//     enhance_config[].enhance_policy_config[].strategy ∈ { AFME, FSR, FRC }
//   Redmi (independent display):
//     enhance_config[].enhance_policy_config[].strategy ∈ { NT#FI, NT#FISR }
//
// Structure:
//   {
//     composite_scene_force_disable?: boolean,   // Mi-side
//     enhance_config: Array<{
//       game_list: string[],
//       support_vk?: boolean,                    // see note below
//       joint_action_cmd?: number[],             // Redmi-side
//       switch_default_status?: string,          // "0#0"
//       enhance_policy_config: Array<{
//         feature: "FI" | "SR" | "FISR" | "RE" | "PQ_FIRST" | "FPS_FIRST",
//         strategy: string,
//         support_max_refresh?: string,          // "60#120"
//       }>
//     }>
//   }
//
// The `support_vk` field matters specifically for Honkai: Star Rail on the
// MIFISR path. Reverse-engineered from `k.b.isSupportEnhance`:
//
//   if (pkg == "com.miHoYo.hkrpg"
//       && scenerecognize.g.b(pkg)              // VulkanModeRecognizer says VK
//       && !this.f3243m.x(pkg)) {               // q.d.x = group.support_vk
//       return 0;                               // → "hkrpg in vk mode but not support vk"
//   }
//
// Practically: on launch / login screen (GL ES menu) isSupportEnhance returns
// 1 and the checkbox shows; once the game switches to its Vulkan pipeline,
// VulkanModeRecognizer reports true and Joyose consults `support_vk`. When
// that field is absent/false, the assistant hides the checkbox. Ultra cloud
// does not ship `support_vk: true` for hkrpg out of the box; users who want
// the checkbox to stay visible after logging in must flip it to true.
// Other per-game VK binding quirks (mingchao, ZZZ, etc.) only affect the
// real render-time effect via libmivk, not this gating.

export type FisrFeature = 'FI' | 'SR' | 'FISR' | 'RE' | 'PQ_FIRST' | 'FPS_FIRST' | string;

export interface FisrPolicy {
  feature: FisrFeature;
  strategy: string;
  /** "X#Y" (MGAME#TGAME). Caps FI output via `min(fps*2, parts[idx])`.
   *  Missing ⇒ Joyose defaults to 60 and silently clamps FI back to the
   *  native fps. Only FI / FISR read this; SR branch of l.i.n ignores it. */
  support_max_refresh?: string;
  /** "X#Y" bitmap, 1 = enabled in that mode, 0 = disabled. */
  support_game_mode?: string;
  /** sceneIds that temporarily disable enhance when the current game scene
   *  lands in the list. Joyose calls stopEnhance on entry and restores on exit. */
  disable_scene_list?: number[];
  /** Comma-separated render-resolution level whitelist (e.g. "4" or "1,2,4").
   *  `l.i.t(pkg, status)` checks current render level against this list BEFORE
   *  activation; a non-match prints `invalid render resolution, ... ignore`
   *  and bails. Leave empty to allow any resolution (recommended unless you
   *  want to mirror Ultra cloud's hkrpg "4"-only whitelist). */
  support_resolution_leave?: string;
  /** "X#Y" bitmap for the per-policy default switch state. Joyose's
   *  `q.d.b(pkg, status)` reads this to seed the initial checkbox state —
   *  affects UX only, not activation gating. */
  switch_default_status?: string;
  [extra: string]: unknown;
}

export interface FisrGroup {
  game_list: string[];
  /** q.b.n()/o(boolean). If true, the assistant keeps the enhance checkbox
   *  visible when the game switches to Vulkan. Only matters for hkrpg today;
   *  harmless on other groups. */
  support_vk?: boolean;
  joint_action_cmd?: number[];
  switch_default_status?: string;
  enhance_policy_config: FisrPolicy[];
  [extra: string]: unknown;
}

export interface FisrConfig {
  composite_scene_force_disable?: boolean;
  enhance_config: FisrGroup[];
  [extra: string]: unknown;
}

export function isFisrConfig(v: unknown): v is FisrConfig {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as FisrConfig).enhance_config) &&
    (v as FisrConfig).enhance_config.every(
      (g) => Array.isArray(g.game_list) && Array.isArray(g.enhance_policy_config),
    )
  );
}

/** Locate the first group whose `game_list` contains `pkg`. */
export function findGroupForPkg(cfg: FisrConfig, pkg: string): FisrGroup | undefined {
  return cfg.enhance_config.find((g) => g.game_list.includes(pkg));
}

/** Give `pkg` a group of its own.
 *
 *  A group can list several games and share one `enhance_policy_config` (and
 *  one `support_vk`). Editing the group to change one game therefore changes
 *  every other game in it. Splitting first keeps the shared group's policy for
 *  the remaining games and gives the edited game an independent copy.
 *
 *  Returns the group that now owns `pkg` (the original one when it is already
 *  alone). */
export function splitPkgGroup(cfg: FisrConfig, pkg: string): FisrGroup | undefined {
  const group = findGroupForPkg(cfg, pkg);
  if (!group) return undefined;
  if (group.game_list.length <= 1) return group;
  const own = clone(group);
  own.game_list = [pkg];
  group.game_list = group.game_list.filter((p) => p !== pkg);
  cfg.enhance_config.push(own);
  return own;
}

/**
 * Upsert a strategy preset for `pkg`. If an existing group already contains
 * `pkg`, it is split out first when that group is shared, so the change cannot
 * leak to the other games listed there; otherwise a new group is appended.
 * Returns the mutated config (also mutates in place).
 */
export function upsertPkgPolicy(
  cfg: FisrConfig,
  pkg: string,
  policy: FisrPolicy[],
  extras?: {
    switch_default_status?: string;
    joint_action_cmd?: number[];
    support_vk?: boolean;
  },
): FisrConfig {
  if (!Array.isArray(cfg.enhance_config)) cfg.enhance_config = [];
  const existing = findGroupForPkg(cfg, pkg);
  if (existing) {
    const target = existing.game_list.length > 1 ? splitPkgGroup(cfg, pkg)! : existing;
    target.enhance_policy_config = clone(policy);
    if (extras?.switch_default_status) target.switch_default_status = extras.switch_default_status;
    if (extras?.joint_action_cmd) target.joint_action_cmd = extras.joint_action_cmd.slice();
    if (typeof extras?.support_vk === 'boolean') target.support_vk = extras.support_vk;
  } else {
    const group: FisrGroup = {
      game_list: [pkg],
      enhance_policy_config: clone(policy),
    };
    if (extras?.switch_default_status) group.switch_default_status = extras.switch_default_status;
    if (extras?.joint_action_cmd) group.joint_action_cmd = extras.joint_action_cmd.slice();
    if (typeof extras?.support_vk === 'boolean') group.support_vk = extras.support_vk;
    cfg.enhance_config.push(group);
  }
  return cfg;
}

/** Set or clear the `support_vk` flag for `pkg` only. The flag is group-level,
 *  so a shared group is split first. No-op if the group doesn't exist yet.
 *  Returns true if the flag was updated. */
export function setPkgSupportVk(cfg: FisrConfig, pkg: string, value: boolean): boolean {
  const group = findGroupForPkg(cfg, pkg);
  if (!group) return false;
  const target = group.game_list.length > 1 ? splitPkgGroup(cfg, pkg)! : group;
  target.support_vk = value;
  return true;
}

export interface GroupImpact {
  /** Other games sharing this group's policy list and support_vk flag. */
  peers: string[];
  /** True when peers is non-empty: any edit will split the group first. */
  shared: boolean;
  /** How many policies the group currently carries. */
  policies: number;
}

/** Who else is affected if `pkg`'s group is edited.
 *
 *  The UI shows this before a preset / feature / support_vk change, because the
 *  split is silent otherwise: the user edits "this game" and cannot tell that
 *  the strategy entry was previously shared with three others. */
export function groupImpact(cfg: FisrConfig, pkg: string): GroupImpact | null {
  const group = findGroupForPkg(cfg, pkg);
  if (!group) return null;
  const peers = group.game_list.filter((p) => p !== pkg);
  return { peers, shared: peers.length > 0, policies: group.enhance_policy_config.length };
}

/**
 * Append a single policy to the group for `pkg`. If the group doesn't exist,
 * create one. If a policy with the same `feature` already exists on the group,
 * this is a no-op and returns false. Returns true when the policy was added.
 */
export function addPolicyForPkg(
  cfg: FisrConfig,
  pkg: string,
  policy: FisrPolicy,
): boolean {
  if (!Array.isArray(cfg.enhance_config)) cfg.enhance_config = [];
  const existing = findGroupForPkg(cfg, pkg);
  if (existing) {
    // A shared group's policy list is common to every listed game; adding to
    // it would enable the feature for all of them.
    const target = existing.game_list.length > 1 ? splitPkgGroup(cfg, pkg)! : existing;
    if (target.enhance_policy_config.some((p) => p.feature === policy.feature)) {
      return false;
    }
    target.enhance_policy_config.push(clone(policy));
  } else {
    cfg.enhance_config.push({
      game_list: [pkg],
      enhance_policy_config: [clone(policy)],
    });
  }
  return true;
}

/**
 * Remove the policy with the given `feature` from `pkg`'s group. If removing
 * it leaves the group's `enhance_policy_config` empty, the whole group is
 * dropped (same semantics as `removePkg`). Returns true when something was
 * actually removed.
 */
export function removePolicyForPkg(
  cfg: FisrConfig,
  pkg: string,
  feature: string,
): boolean {
  const existing = findGroupForPkg(cfg, pkg);
  if (!existing) return false;
  // Same reason as addPolicyForPkg: removing from a shared list would disable
  // the feature for the other games in the group.
  const target = existing.game_list.length > 1 ? splitPkgGroup(cfg, pkg)! : existing;
  const before = target.enhance_policy_config.length;
  target.enhance_policy_config = target.enhance_policy_config.filter(
    (p) => p.feature !== feature,
  );
  if (target.enhance_policy_config.length === before) return false;
  if (target.enhance_policy_config.length === 0) removePkg(cfg, pkg);
  return true;
}

/** Remove `pkg` from every group; drop empty groups. */
export function removePkg(cfg: FisrConfig, pkg: string): FisrConfig {
  if (!Array.isArray(cfg.enhance_config)) return cfg;
  for (const g of cfg.enhance_config) {
    g.game_list = g.game_list.filter((p) => p !== pkg);
  }
  cfg.enhance_config = cfg.enhance_config.filter((g) => g.game_list.length > 0);
  return cfg;
}

/** Strategy presets keyed by path label — see the project plan for semantics. */
export const STRATEGY_PRESETS = {
  /** Mi 15 / 15 Pro style. FI runs on AFME, SR on FSR, the combined FISR/RE on FRC. */
  qualcommStandard(supportMaxRefresh = '60#120'): FisrPolicy[] {
    return [
      { feature: 'FI', strategy: 'AFME', support_max_refresh: supportMaxRefresh },
      { feature: 'SR', strategy: 'FSR' },
      { feature: 'FISR', strategy: 'FRC' },
      { feature: 'RE', strategy: 'FRC' },
    ];
  },
  /** Mi-style at 60→90 (star rail) */
  qualcomm6090(): FisrPolicy[] {
    return [
      { feature: 'FI', strategy: 'AFME', support_max_refresh: '60#90' },
      { feature: 'SR', strategy: 'FSR' },
      { feature: 'FISR', strategy: 'FRC' },
      { feature: 'RE', strategy: 'FRC' },
    ];
  },
  /** Redmi independent-display style. */
  novatekStandard(): FisrPolicy[] {
    return [
      { feature: 'PQ_FIRST', strategy: 'NT#FISR' },
      { feature: 'FPS_FIRST', strategy: 'NT#FI' },
    ];
  },
  /** 17 series (8 Elite 2 + MIFISR backend). Returns THREE policies all bound
   * to `strategy: MIFISR`, matching what Xiaomi 17 Ultra actually ships from
   * cloud control.
   *
   * Why all three bind to MIFISR (as opposed to FI→DMI / SR→MISR / FISR→MIFISR
   * which is what the registry table `k.e.n()` might suggest):
   *
   *   setEnhanceStatus(pkg, status) works like this:
   *     1. e.i(pkg, status) looks up a strategy instance from fisr_config
   *        (`feature` + `strategy` name pair).
   *     2. On the returned instance, Joyose immediately calls `k(pkg, status)`.
   *     3. Then activation kicks off.
   *
   *   For DMI (l.b), MISR (l.j), DPQ (l.c) the interface default `k()` is a
   *   no-op and their `a()` returns a fixed constant (1 / 2 / 2).
   *   For MIFISR (l.i), `k(pkg, status)` stores `f3316e[pkg] = status` and
   *   `a()` returns `f3316e.getOrDefault(pkg, 4)` — so a single MIFISR
   *   instance can impersonate status 1 / 2 / 4 on demand. That's why every
   *   feature can legitimately bind to MIFISR.
   *
   *   Activation's only real side-effect is `s.y(ctx).J(pkg, status)` which
   *   writes `"11 <pkg> <status>"` to the kernel mcd channel at
   *   /data/system/mcd/gameInfo (eventId 11 = MIFISR). Kernel mcd + the MiVK
   *   xrender hook pipeline then handle the visible FI/SR processing —
   *   Joyose strategy is just the scheduler/notifier.
   *
   * Ultra's own fisr_config only ships ONE policy (feature:SR + MIFISR) per
   * game. We still return three so the WebUI "+ FI / + SR / + FISR" buttons
   * have a common source of truth for each feature's default strategy.
   *
   * `support_game_mode` is a 2-position bitmap `[MGAME=均衡, TGAME=性能]`
   * (NOT a mode-id enumeration). **`1` = enabled in this mode, `0` = disabled**.
   * Confirmed by on-device test: Ultra ships hkrpg with `"0#1"`, and that
   * does hide the checkbox under 均衡 while showing it under 性能 — exactly
   * what `parts[idx] == 1 ? enable : disable` predicts. Default `"1#1"` =
   * enabled in both modes; what cloud ships for each game varies.
   *
   * `support_max_refresh` also uses `"X#Y"` (MGAME#TGAME) — it caps the FI
   * output refresh rate. `l.i.r()` computes `min(gameFps*2, supportMaxFps)`
   * and that value is what Joyose pushes to the display; with this field
   * missing the default is **60Hz**, which silently clamps FI back to the
   * original fps and the user sees no doubled frames despite strategy
   * activation. Default `"60#120"` lets both modes push up to 120Hz.
   * **Only FI / FISR policies need this field** — SR is spatial upscaling
   * and `l.i.n()`'s SR branch doesn't read `support_max_refresh` at all
   * (Ultra's cloud ships `feature:SR` without it, matching this). Users on
   * 144Hz panels may want to bump it to "144#144".
   *
   * Scene 10004 is the common "cutscene / video" disable; 1051 / 1052 are
   * Genshin-specific world UI scenes so callers should trim them for
   * non-Genshin games. */
  mifisrStandard(opts?: {
    disableScenes?: number[];
    supportGameMode?: string;
    supportMaxRefresh?: string;
  }): FisrPolicy[] {
    const mode = opts?.supportGameMode ?? '1#1';
    const maxRefresh = opts?.supportMaxRefresh ?? '60#120';
    const scenes = opts?.disableScenes ?? [10004];
    return [
      { feature: 'FI',   strategy: 'MIFISR', support_game_mode: mode, support_max_refresh: maxRefresh, disable_scene_list: scenes },
      { feature: 'SR',   strategy: 'MIFISR', support_game_mode: mode,                                   disable_scene_list: scenes },
      { feature: 'FISR', strategy: 'MIFISR', support_game_mode: mode, support_max_refresh: maxRefresh, disable_scene_list: scenes },
    ];
  },
} as const;

export type PresetName = keyof typeof STRATEGY_PRESETS;

export function emptyFisrConfig(): FisrConfig {
  return { composite_scene_force_disable: true, enhance_config: [] };
}

/**
 * `support_game_mode` must be exactly `"X#Y"` where X, Y ∈ {0, 1}. Joyose's
 * `k.e.u()` calls `split("#")` and reads `parts[isMGAME ? 0 : 1]`; a malformed
 * value silently falls back to "feature is listed" (mode check skipped), so
 * the user never notices their per-mode intent was ignored. Use this at edit
 * boundaries to refuse non-conforming input instead of letting it drift in.
 */
export function isValidSupportGameMode(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const parts = v.split('#');
  return parts.length === 2 && parts.every((p) => p === '0' || p === '1');
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
