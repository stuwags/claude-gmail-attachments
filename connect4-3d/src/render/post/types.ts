/**
 * Contract for the post-processing chain (bible §4).
 *
 * The scene owns the frame loop and calls `render` once per frame; the chain
 * owns every effect between the scene and the canvas. Keeping the chain behind
 * this interface means the lighting and materials can be judged with post
 * bypassed — which is exactly the order the bible demands, since a correct
 * lighting rig with no post beats a weak rig with all nine passes.
 */

import type { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import type { QualityTier } from '../api.ts';

/**
 * Which depth-of-field regime is in force. `play` keeps the whole board sharp
 * and touches only the backdrop; `win` and `menu` tighten to an f/2.8 metaphor.
 */
export type PostState = 'play' | 'win' | 'menu';

/** Individual effects can be bypassed for the §9 A/B acceptance checks. */
export type BypassTarget = 'bloom' | 'ao' | 'dof' | 'grain' | 'chromatic' | 'vignette' | 'all';

export interface PostFXOptions {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  quality: QualityTier;
  reducedMotion: boolean;
}

export interface PostFX {
  /** Render the scene through the chain to the canvas. `dtMs` drives grain animation. */
  render(dtMs: number): void;

  /** Backing-store resize, in device pixels. */
  resize(width: number, height: number): void;

  /**
   * Move to a depth-of-field regime, easing over 600 ms on the camera curve.
   * `immediate` snaps instead, for resets and harness scrubbing.
   */
  setState(state: PostState, immediate?: boolean): void;

  /**
   * Explicit focus override from the outcome sequence, which needs to hold the
   * winning line on the focus plane. `null` returns control to `setState`.
   */
  setFocusOverride(focus: { worldFocusRange: number; bokehScale: number } | null): void;

  /** Added to the base vignette darkness; the loss sequence pushes this up. */
  setVignetteBias(bias: number): void;

  /** Swap the Tier A and Tier B configurations at runtime. */
  setQuality(tier: QualityTier): void;

  /** Disable effects for acceptance checks. Pass an empty array to restore all. */
  setBypass(targets: readonly BypassTarget[]): void;

  dispose(): void;
}
