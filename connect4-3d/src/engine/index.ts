/**
 * The rules engine, threat analysis and AI, in one import.
 *
 *   import { Board, analyze, chooseMove } from './engine/index.ts';
 *
 * `types.ts` is the shared contract; everything else here implements it.
 */

export * from './types.ts';

export {
  Board,
  WINDOWS,
  type WindowSpec,
  // Bitboard plumbing — exported so the search (and its tests) can reach it.
  BOARD_HI,
  BOARD_LO,
  BOTTOM_HI,
  BOTTOM_LO,
  COLUMN_BITS,
  HI_MASK,
  LO_MASK,
  SPLIT,
  cellHi,
  cellLo,
  computeWinningSquares,
  popcount,
  shlHi,
  shlLo,
  shrLo,
  winsIn,
} from './board.ts';

export { analyze, windows } from './threats.ts';

export { chooseMove, clearTranspositionTable, evaluate, type SearchOptions } from './ai.ts';
