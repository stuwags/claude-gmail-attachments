/**
 * Main-thread handle on the search worker.
 *
 * Falls back to searching inline if workers are unavailable — some WKWebView
 * configurations and file:// contexts refuse module workers, and a game that
 * refuses to start is worse than one that stutters for half a second while the
 * computer thinks.
 */

import type { AiDecision, Difficulty } from '../engine/types.ts';
import type { AiRequest, AiResponse } from './ai-worker.ts';

export interface ThinkOptions {
  /** Columns played so far, in order. The whole game state. */
  moves: number[];
  difficulty: Difficulty;
  timeBudgetMs?: number;
  seed: number;
}

export class AiClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (d: AiDecision) => void; reject: (e: Error) => void }
  >();
  /** Set when worker construction failed; we search on the main thread instead. */
  private inlineFallback = false;

  constructor() {
    try {
      this.worker = new Worker(new URL('./ai-worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<AiResponse>) => this.onMessage(event.data);
      this.worker.onerror = (event) => this.failAll(new Error(event.message || 'AI worker failed'));
    } catch {
      this.inlineFallback = true;
    }
  }

  /** True when the search is running on the main thread and will block it. */
  get isInline(): boolean {
    return this.inlineFallback;
  }

  async think(opts: ThinkOptions): Promise<AiDecision> {
    if (this.inlineFallback || !this.worker) return this.thinkInline(opts);

    const id = this.nextId++;
    const request: AiRequest = {
      id,
      moves: opts.moves,
      difficulty: opts.difficulty,
      timeBudgetMs: opts.timeBudgetMs,
      seed: opts.seed,
    };

    return new Promise<AiDecision>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage(request);
    });
  }

  /**
   * Abandon every in-flight search. Called on restart and undo, where the
   * answer is about to be meaningless.
   */
  cancel(): void {
    this.failAll(new Error('cancelled'), true);
  }

  dispose(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
  }

  private onMessage(res: AiResponse): void {
    const entry = this.pending.get(res.id);
    if (!entry) return; // Cancelled while in flight.
    this.pending.delete(res.id);
    if (res.ok) entry.resolve(res.decision);
    else entry.reject(new Error(res.error));
  }

  private failAll(err: Error, silent = false): void {
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
    if (!silent && !this.inlineFallback) {
      // The worker is unusable from here on; degrade rather than dying.
      this.inlineFallback = true;
      this.worker?.terminate();
      this.worker = null;
    }
  }

  private async thinkInline(opts: ThinkOptions): Promise<AiDecision> {
    const [{ Board }, { chooseMove }, { mulberry32 }] = await Promise.all([
      import('../engine/board'),
      import('../engine/ai'),
      import('../render/procedural'),
    ]);
    const board = Board.fromMoves(opts.moves);
    return chooseMove(board, {
      difficulty: opts.difficulty,
      timeBudgetMs: opts.timeBudgetMs,
      rng: mulberry32(opts.seed),
    });
  }
}
