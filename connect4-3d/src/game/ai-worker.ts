/**
 * AI search, off the main thread.
 *
 * Hard mode spends the better part of a second in alpha-beta. On the main
 * thread that would stall the render loop and turn a 120Hz iPad into a
 * slideshow every time the computer moves, so the search runs here and the
 * board keeps animating while it thinks.
 *
 * Only the move list crosses the boundary — it is the whole game state, and it
 * is seven bytes rather than a serialised object graph.
 */

import { Board } from '../engine/board.ts';
import { chooseMove } from '../engine/ai.ts';
import { mulberry32 } from '../render/procedural.ts';
import type { AiDecision, Difficulty } from '../engine/types.ts';

export interface AiRequest {
  id: number;
  moves: number[];
  difficulty: Difficulty;
  timeBudgetMs?: number;
  /** Seeded so a given game replays identically. */
  seed: number;
}

export type AiResponse =
  | { id: number; ok: true; decision: AiDecision }
  | { id: number; ok: false; error: string };

self.onmessage = (event: MessageEvent<AiRequest>) => {
  const req = event.data;
  let response: AiResponse;
  try {
    const board = Board.fromMoves(req.moves);
    const decision = chooseMove(board, {
      difficulty: req.difficulty,
      timeBudgetMs: req.timeBudgetMs,
      rng: mulberry32(req.seed),
    });
    response = { id: req.id, ok: true, decision };
  } catch (err) {
    response = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as Worker).postMessage(response);
};
