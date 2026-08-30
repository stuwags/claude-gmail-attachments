/**
 * How much coaching each rung of the ladder starts with.
 *
 * The coach fades out as the difficulty climbs rather than switching off at a
 * threshold: a player on Steady is still learning to see threats, and one on
 * Grandmaster is not. This is a product rule, and it lived in three places at
 * once — the title screen's option list, the controller's "turn the coach on
 * for easy" branch, and the debug hook — which is two places too many for a
 * rule that has to agree with itself.
 *
 * It is only a *default*. Touching the coach chip overrides it, and nothing
 * here re-imposes it on a player who has made a choice.
 */

import type { Difficulty } from '../engine/types.ts';
import type { CoachMode } from '../render/effects/types.ts';

export const DEFAULT_COACH_FOR: Record<Difficulty, CoachMode> = {
  easy: 'full',
  steady: 'full',
  medium: 'hints',
  hard: 'hints',
  grandmaster: 'off',
};
