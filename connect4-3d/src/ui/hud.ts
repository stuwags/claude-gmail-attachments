/**
 * The DOM chrome: title screen, in-play furniture, settings sheet, outcome
 * banner. Implements `Hud` from ./types.ts, which is frozen.
 *
 * Two rules shape the whole file.
 *
 * The first is §8.3: during play there are exactly three things on screen —
 * settings, the coach chip, the turn capsule — and the 3D board is the hero.
 * So the chrome is sparse by construction, and the title screen is a panel in
 * the margin rather than a splash over the object.
 *
 * The second is that this file must never intercept a pointer event meant for
 * the canvas. Every container is `pointer-events: none` and only the controls
 * themselves opt back in; the turn capsule, which is a readout and not a
 * control, stays transparent to the pointer too. The only element that ever
 * covers the board is the settings scrim, and only while the sheet is open.
 */

import { COLS, Player, other } from '../engine/types';
import type { Difficulty } from '../engine/types';
import type { CoachMode } from '../render/effects/types';
import type { QualityTier } from '../render/api';
import { COLUMN_DROP_EVENT, COLUMN_SELECT_EVENT } from './events';
import { el, icon, setAttr, setHidden, setText } from './dom';
import type { GameSnapshot, Hud, HudCallbacks, MatchConfig } from './types';

/* ---------------------------------------------------------------- *
 * Vocabulary and copy. Sentence case, short, calm (§8.1).
 * ---------------------------------------------------------------- */

const nameOf = (p: Player): string => (p === Player.One ? 'Ember' : 'Petrol');
const tintOf = (p: Player): 'ember' | 'petrol' => (p === Player.One ? 'ember' : 'petrol');
const glowOf = (p: Player): string =>
  p === Player.One ? 'var(--c4-ember-glow)' : 'var(--c4-petrol-glow)';

/** Coach default per difficulty. §7.3: "Easy mode defaults to Full." */
const COACH_FOR: Record<Difficulty, CoachMode> = { easy: 'full', medium: 'hints', hard: 'off' };

const COACH_NOTE: Record<CoachMode, string> = {
  off: 'No marks on the board.',
  hints: 'Marks the lines that can be won or lost this turn.',
  full: 'Also shows the shapes as they build.',
};

const COACH_LEVEL: Record<CoachMode, number> = { off: 0, hints: 1, full: 2 };
const COACH_LABEL: Record<CoachMode, string> = { off: 'Off', hints: 'Hints', full: 'Full' };
const COACH_CYCLE: Record<CoachMode, CoachMode> = { off: 'hints', hints: 'full', full: 'off' };

const DIFFICULTIES: readonly SegItem<Difficulty>[] = [
  { value: 'easy', label: 'Easy', desc: 'Coach on. Teaches a child to spot threats.' },
  { value: 'medium', label: 'Medium', desc: 'Steady. Punishes an obvious mistake.' },
  { value: 'hard', label: 'Hard', desc: 'Searches deep. It misses nothing.' },
];

const COACH_MODES: readonly SegItem<CoachMode>[] = [
  { value: 'off', label: 'Off' },
  { value: 'hints', label: 'Hints' },
  { value: 'full', label: 'Full' },
];

const QUALITIES: readonly SegItem<QualityTier>[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'ultra', label: 'Ultra' },
];

const GEAR = [
  ['path', { d: 'M4 7h16' }],
  ['circle', { cx: '9', cy: '7', r: '2.4' }],
  ['path', { d: 'M4 13h16' }],
  ['circle', { cx: '15', cy: '13', r: '2.4' }],
  ['path', { d: 'M4 19h16' }],
  ['circle', { cx: '8', cy: '19', r: '2.4' }],
] as const;

const CROSS = [
  ['path', { d: 'M6.5 6.5l11 11' }],
  ['path', { d: 'M17.5 6.5l-11 11' }],
] as const;

let uid = 0;
const nextId = (): string => `c4-${(uid += 1)}`;

/* ---------------------------------------------------------------- *
 * Segmented picker — the one control idiom in the product.
 * ---------------------------------------------------------------- */

interface SegItem<T extends string> {
  value: T;
  label: string;
  /** Supporting line, stacked variant only. */
  desc?: string;
  /** Shows the disc swatch and tints the 3 px selection indicator (§8.2). */
  tint?: 'ember' | 'petrol';
}

interface Segmented<T extends string> {
  root: HTMLElement;
  options: HTMLButtonElement[];
  set(value: T): void;
}

/**
 * An ARIA radiogroup with roving tab index. Arrow keys move and select, and
 * the group swallows them so the global handler does not also move the column
 * aim underneath.
 */
function segmented<T extends string>(
  groupLabel: string,
  items: readonly SegItem<T>[],
  variant: 'row' | 'stack',
  onPick: (value: T) => void,
): Segmented<T> {
  const root = el('div', `c4-seg c4-seg--${variant}`);
  root.setAttribute('role', 'radiogroup');
  root.setAttribute('aria-label', groupLabel);

  const options: HTMLButtonElement[] = [];

  const set = (value: T): void => {
    let checked = items.findIndex((i) => i.value === value);
    if (checked < 0) checked = 0;
    options.forEach((b, i) => {
      setAttr(b, 'aria-checked', i === checked ? 'true' : 'false');
      b.tabIndex = i === checked ? 0 : -1;
    });
  };

  items.forEach((item) => {
    const b = el('button', `c4-seg__opt${item.tint ? ` c4-seg__opt--${item.tint}` : ''}`);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.tabIndex = -1;

    const label = el('span', 'c4-seg__label');
    if (item.tint) label.appendChild(el('span', 'c4-swatch'));
    label.appendChild(el('span', 'c4-t-headline', item.label));
    b.appendChild(label);

    if (item.desc) {
      const note = el('span', 'c4-seg__desc c4-t-caption', item.desc);
      note.id = nextId();
      b.appendChild(note);
      // Keep the accessible name to the option itself; the line is a description.
      b.setAttribute('aria-label', item.label);
      b.setAttribute('aria-describedby', note.id);
    }

    b.addEventListener('click', () => {
      set(item.value);
      onPick(item.value);
    });

    options.push(b);
    root.appendChild(b);
  });

  root.addEventListener('keydown', (ev) => {
    const k = ev.key;
    if (k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'ArrowUp' && k !== 'ArrowDown' &&
        k !== 'Home' && k !== 'End') {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (k === 'Home') next = 0;
    else if (k === 'End') next = options.length - 1;
    else {
      const step = k === 'ArrowRight' || k === 'ArrowDown' ? 1 : -1;
      next = at < 0 ? 0 : (at + step + options.length) % options.length;
    }
    const target = options[next];
    target.focus();
    target.click();
  });

  set(items[0].value);
  return { root, options, set };
}

/** Micro label above a control, per §8.1. */
function field(label: string, ...children: HTMLElement[]): HTMLElement {
  const wrap = el('div', 'c4-field');
  wrap.appendChild(el('span', 'c4-t-micro', label));
  for (const c of children) wrap.appendChild(c);
  return wrap;
}

function actionButton(label: string): HTMLButtonElement {
  const b = el('button', 'c4-t-headline', label);
  b.type = 'button';
  return b;
}

/* ---------------------------------------------------------------- *
 * The HUD
 * ---------------------------------------------------------------- */

export function createHud(): Hud {
  let cb: HudCallbacks | null = null;
  let snap: GameSnapshot | null = null;
  let mounted = false;

  /** Title-screen selections, local until Start is pressed. */
  const draft: MatchConfig = {
    difficulty: 'medium',
    vsAi: true,
    humanPlayer: Player.One,
    coachMode: COACH_FOR.medium,
  };
  /** Once the player picks a coach mode by hand, difficulty stops overriding it. */
  let coachTouched = false;

  let sheetOpen = false;
  let bannerVisible = false;
  let lastFocus: HTMLElement | null = null;
  let selected: number | null = null;
  let spoken = '';

  /* ---------------- structure ---------------- */

  const hud = el('div', 'c4-hud');

  // One polite live region carries every announcement: turn changes, the coach
  // advisory, the aimed column, setting changes and the outcome.
  const live = el('div', 'c4-sr');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  hud.appendChild(live);

  const say = (text: string): void => {
    if (!text || text === spoken) return;
    spoken = text;
    setText(live, text);
  };

  /* ---------------- in-play chrome (§8.3) ---------------- */

  const play = el('div', 'c4-play c4-fade');

  const settingsBtn = el('button', 'c4-iconbtn c4-panel c4-play__settings');
  settingsBtn.type = 'button';
  settingsBtn.setAttribute('aria-label', 'Settings');
  settingsBtn.setAttribute('aria-haspopup', 'dialog');
  settingsBtn.setAttribute('aria-expanded', 'false');
  settingsBtn.appendChild(icon(GEAR));
  settingsBtn.addEventListener('click', () => openSheet());
  play.appendChild(settingsBtn);

  const coachChip = el('button', 'c4-chip c4-panel c4-play__coach');
  coachChip.type = 'button';
  const coachChipText = el('span', 'c4-t-headline', 'Off');
  const coachLevel = el('span', 'c4-level');
  const coachSegs = [el('span', 'c4-level__seg'), el('span', 'c4-level__seg')];
  for (const s of coachSegs) coachLevel.appendChild(s);
  const coachChipLabel = el('span', 'c4-chip__label');
  coachChipLabel.appendChild(el('span', 'c4-t-micro', 'Coach'));
  coachChipLabel.appendChild(coachChipText);
  coachChip.appendChild(coachChipLabel);
  coachChip.appendChild(coachLevel);
  coachChip.addEventListener('click', () => {
    if (!snap || !cb) return;
    const next = COACH_CYCLE[snap.coachMode];
    coachTouched = true;
    cb.onSetCoachMode(next);
    say(`Coach ${COACH_LABEL[next].toLowerCase()}. ${COACH_NOTE[next]}`);
  });
  play.appendChild(coachChip);

  // Bottom centre, 52pt (§8.3). Deliberately not interactive, so a click here
  // lands on the board behind it.
  const capsule = el('div', 'c4-capsule c4-panel c4-play__capsule c4-fade');
  capsule.setAttribute('aria-hidden', 'true');
  const capsuleBar = el('span', 'c4-capsule__bar');
  const capsuleTurn = el('span', 'c4-capsule__turn c4-t-headline', '');
  const capsuleAdvice = el('span', 'c4-capsule__advice c4-t-caption', '');
  const capsuleText = el('div', 'c4-capsule__text');
  capsuleText.appendChild(capsuleTurn);
  capsuleText.appendChild(capsuleAdvice);
  capsule.appendChild(capsuleBar);
  capsule.appendChild(capsuleText);
  play.appendChild(capsule);

  hud.appendChild(play);

  /* ---------------- title screen ---------------- */

  const menu = el('div', 'c4-menu c4-fade');
  const menuPanel = el('div', 'c4-panel c4-menu__panel');
  menuPanel.setAttribute('role', 'group');
  menuPanel.tabIndex = -1;

  const titleId = nextId();
  const titleBlock = el('div', 'c4-menu__title');
  titleBlock.appendChild(el('span', 'c4-t-micro', 'Smoke & ember'));
  const heading = el('h1', 'c4-t-title', 'Connect Four');
  heading.id = titleId;
  titleBlock.appendChild(heading);
  titleBlock.appendChild(el('p', 'c4-t-caption', 'Four in a row. Take your time.'));
  menuPanel.setAttribute('aria-labelledby', titleId);
  menuPanel.appendChild(titleBlock);

  const menuDifficulty = segmented<Difficulty>('Difficulty', DIFFICULTIES, 'stack', (v) => {
    draft.difficulty = v;
    if (!coachTouched) {
      draft.coachMode = COACH_FOR[v];
      menuCoach.set(draft.coachMode);
      setText(menuCoachNote, COACH_NOTE[draft.coachMode]);
    }
    say(`Difficulty ${v}.`);
  });
  menuPanel.appendChild(field('Difficulty', menuDifficulty.root));

  const menuOpponent = segmented<'ai' | 'human'>(
    'Opponent',
    [
      { value: 'ai', label: 'The computer' },
      { value: 'human', label: 'A friend' },
    ],
    'row',
    (v) => {
      draft.vsAi = v === 'ai';
      say(v === 'ai' ? 'Playing the computer.' : 'Playing a friend.');
    },
  );
  menuPanel.appendChild(field('Opponent', menuOpponent.root));

  const menuColour = segmented<'ember' | 'petrol'>(
    'Your colour',
    [
      { value: 'ember', label: 'Ember', tint: 'ember' },
      { value: 'petrol', label: 'Petrol', tint: 'petrol' },
    ],
    'row',
    (v) => {
      draft.humanPlayer = v === 'ember' ? Player.One : Player.Two;
      say(`You play ${v}.`);
    },
  );
  const colourNote = el('p', 'c4-t-caption', 'Ember always moves first.');
  menuPanel.appendChild(field('Your colour', menuColour.root, colourNote));

  const menuCoachNote = el('p', 'c4-t-caption', COACH_NOTE[draft.coachMode]);
  const menuCoach = segmented<CoachMode>('Coach', COACH_MODES, 'row', (v) => {
    draft.coachMode = v;
    coachTouched = true;
    setText(menuCoachNote, COACH_NOTE[v]);
    say(`Coach ${v}. ${COACH_NOTE[v]}`);
  });
  menuPanel.appendChild(field('Coach', menuCoach.root, menuCoachNote));

  const startBtn = el('button', 'c4-menu__start c4-t-headline', 'Start');
  startBtn.type = 'button';
  startBtn.addEventListener('click', () => cb?.onStartMatch({ ...draft }));
  menuPanel.appendChild(startBtn);

  menu.appendChild(menuPanel);
  hud.appendChild(menu);

  /* ---------------- settings sheet ---------------- */

  const scrim = el('div', 'c4-scrim');
  scrim.addEventListener('click', () => closeSheet());
  hud.appendChild(scrim);

  const sheet = el('div', 'c4-sheet c4-fade');
  const sheetPanel = el('div', 'c4-panel c4-sheet__panel');
  const sheetTitleId = nextId();
  sheetPanel.setAttribute('role', 'dialog');
  sheetPanel.setAttribute('aria-modal', 'true');
  sheetPanel.setAttribute('aria-labelledby', sheetTitleId);
  sheetPanel.tabIndex = -1;

  const sheetHead = el('div', 'c4-sheet__head');
  const sheetTitle = el('h2', 'c4-t-micro', 'Settings');
  sheetTitle.id = sheetTitleId;
  const sheetClose = el('button', 'c4-iconbtn');
  sheetClose.type = 'button';
  sheetClose.setAttribute('aria-label', 'Close settings');
  sheetClose.appendChild(icon(CROSS));
  sheetClose.addEventListener('click', () => closeSheet());
  sheetHead.appendChild(sheetTitle);
  sheetHead.appendChild(sheetClose);
  sheetPanel.appendChild(sheetHead);

  const sheetDifficulty = segmented<Difficulty>(
    'Difficulty',
    DIFFICULTIES.map(({ value, label }) => ({ value, label })),
    'row',
    (v) => {
      cb?.onSetDifficulty(v);
      say(`Difficulty ${v}.`);
    },
  );
  sheetPanel.appendChild(field('Difficulty', sheetDifficulty.root));

  const sheetCoachNote = el('p', 'c4-t-caption', COACH_NOTE.off);
  const sheetCoach = segmented<CoachMode>('Coach', COACH_MODES, 'row', (v) => {
    coachTouched = true;
    cb?.onSetCoachMode(v);
    say(`Coach ${v}. ${COACH_NOTE[v]}`);
  });
  sheetPanel.appendChild(field('Coach', sheetCoach.root, sheetCoachNote));

  const sheetSound = segmented<'on' | 'off'>(
    'Sound',
    [
      { value: 'on', label: 'On' },
      { value: 'off', label: 'Off' },
    ],
    'row',
    (v) => {
      if (!snap || !cb) return;
      if (snap.muted === (v === 'off')) return; // already there
      cb.onToggleMute();
      say(v === 'on' ? 'Sound on.' : 'Sound off.');
    },
  );
  sheetPanel.appendChild(field('Sound', sheetSound.root));

  const sheetQuality = segmented<QualityTier>('Quality', QUALITIES, 'row', (v) => {
    cb?.onSetQuality(v);
    say(`Quality ${v}.`);
  });
  sheetPanel.appendChild(field('Quality', sheetQuality.root));

  sheetPanel.appendChild(el('div', 'c4-rule'));

  const undoBtn = actionButton('Undo');
  undoBtn.addEventListener('click', () => cb?.onUndo());
  const restartBtn = actionButton('Restart');
  restartBtn.addEventListener('click', () => {
    closeSheet(false);
    cb?.onRestart();
  });
  const menuBtn = actionButton('Back to the title');
  menuBtn.className += ' c4-actions__wide';
  menuBtn.addEventListener('click', () => {
    closeSheet(false);
    cb?.onOpenMenu();
  });
  const actions = el('div', 'c4-actions');
  actions.appendChild(undoBtn);
  actions.appendChild(restartBtn);
  actions.appendChild(menuBtn);
  sheetPanel.appendChild(actions);

  const readout = el('div', 'c4-readout');
  const readoutMoves = el('p', 'c4-t-caption c4-num', '');
  const readoutSearch = el('p', 'c4-t-caption c4-num', '');
  readout.appendChild(readoutMoves);
  readout.appendChild(readoutSearch);
  sheetPanel.appendChild(readout);

  sheet.appendChild(sheetPanel);
  hud.appendChild(sheet);

  // Modal focus trap.
  sheet.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Tab') return;
    const stops = Array.from(sheetPanel.querySelectorAll<HTMLButtonElement>('button')).filter(
      (b) => !b.disabled && b.tabIndex >= 0,
    );
    if (stops.length === 0) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  });

  /* ---------------- outcome banner (§6) ---------------- */

  const banner = el('div', 'c4-banner c4-fade');
  const bannerPanel = el('div', 'c4-panel c4-banner__panel');
  bannerPanel.setAttribute('role', 'group');
  const bannerAccent = el('span', 'c4-banner__accent');
  const bannerText = el('p', 'c4-banner__text c4-t-banner', '');
  const bannerActions = el('div', 'c4-banner__actions');
  const againBtn = actionButton('Play again');
  againBtn.addEventListener('click', () => {
    hideBannerInternal();
    cb?.onRestart();
  });
  const titleBtn = actionButton('Title');
  titleBtn.addEventListener('click', () => {
    hideBannerInternal();
    cb?.onOpenMenu();
  });
  bannerActions.appendChild(againBtn);
  bannerActions.appendChild(titleBtn);
  bannerPanel.appendChild(bannerAccent);
  bannerPanel.appendChild(bannerText);
  bannerPanel.appendChild(bannerActions);
  banner.appendChild(bannerPanel);
  hud.appendChild(banner);

  setHidden(menu, true);
  setHidden(play, true);
  setHidden(sheet, true);
  setHidden(scrim, true);
  setHidden(banner, true);

  /* ---------------- behaviour ---------------- */

  function openSheet(): void {
    if (sheetOpen || !mounted) return;
    sheetOpen = true;
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAttr(settingsBtn, 'aria-expanded', 'true');
    setHidden(scrim, false);
    setHidden(sheet, false);
    syncSheet();
    sheetClose.focus();
    say('Settings.');
  }

  function closeSheet(restoreFocus = true): void {
    if (!sheetOpen) return;
    sheetOpen = false;
    setAttr(settingsBtn, 'aria-expanded', 'false');
    setHidden(scrim, true);
    setHidden(sheet, true);
    if (restoreFocus) (lastFocus ?? settingsBtn).focus();
    lastFocus = null;
  }

  function hideBannerInternal(): void {
    if (!bannerVisible) return;
    bannerVisible = false;
    setHidden(banner, true);
    syncPlay();
  }

  /**
   * The Easy-mode advisory. `urgentColumns` is read as the columns the player
   * to move must answer, i.e. the *opponent's* immediate wins — the reading
   * that produces the copy in the UX spec ("Petrol can win in column 4 —
   * block it."). Indices are the engine's 0-based `col 0..6`; the chrome shows
   * them 1-based so they match the number keys.
   */
  function advisory(s: GameSnapshot): string {
    if (s.difficulty !== 'easy' || s.coachMode === 'off') return '';
    if (s.phase !== 'playing' && s.phase !== 'thinking' && s.phase !== 'animating') return '';
    const cols = Array.from(new Set(s.urgentColumns.filter((c) => c >= 0 && c < COLS))).sort(
      (a, b) => a - b,
    );
    if (cols.length === 0) return '';
    const threat = nameOf(other(s.toMove));
    const shown = cols.map((c) => String(c + 1));
    if (shown.length === 1) return `${threat} can win in column ${shown[0]} — block it.`;
    const last = shown.pop() as string;
    return `${threat} can win in columns ${shown.join(', ')} and ${last}.`;
  }

  function turnLine(s: GameSnapshot): string {
    if (s.phase === 'thinking') return `${nameOf(s.toMove)} is thinking.`;
    if (s.vsAi && s.toMove === s.humanPlayer) return 'Your move.';
    return `${nameOf(s.toMove)} to move.`;
  }

  function announcement(s: GameSnapshot): string {
    if (s.phase === 'menu') return 'Title screen. Choose a difficulty, then start.';
    if (s.phase === 'over') return ''; // the banner speaks for this state
    const parts: string[] = [];
    if (s.phase === 'thinking') parts.push(`${nameOf(s.toMove)} is thinking.`);
    else if (s.vsAi && s.toMove === s.humanPlayer)
      parts.push(`Your move, ${nameOf(s.toMove).toLowerCase()}.`);
    else parts.push(`${nameOf(s.toMove)} to move.`);
    const advice = advisory(s);
    if (advice) parts.push(advice);
    parts.push(`Move ${s.moveCount + 1}.`);
    return parts.join(' ');
  }

  function syncPlay(): void {
    const s = snap;
    if (!s) return;
    const inMatch = s.phase !== 'menu';
    setHidden(play, !inMatch);

    setText(coachChipText, COACH_LABEL[s.coachMode]);
    coachChip.style.setProperty('--c4-accent', glowOf(s.humanPlayer));
    coachChip.setAttribute(
      'aria-label',
      `Coach: ${COACH_LABEL[s.coachMode].toLowerCase()}. Changes to ${COACH_LABEL[
        COACH_CYCLE[s.coachMode]
      ].toLowerCase()}.`,
    );
    const lit = COACH_LEVEL[s.coachMode];
    coachSegs.forEach((seg, i) => setAttr(seg, 'data-lit', i < lit ? '' : null));

    const showCapsule =
      s.phase === 'playing' || s.phase === 'thinking' || s.phase === 'animating';
    setHidden(capsule, !showCapsule || bannerVisible);
    if (showCapsule) {
      capsule.style.setProperty('--c4-accent', glowOf(s.toMove));
      setText(capsuleTurn, turnLine(s));
      const advice = advisory(s);
      setText(capsuleAdvice, advice);
      capsuleAdvice.style.display = advice ? '' : 'none';
    }
  }

  function syncMenu(): void {
    const s = snap;
    if (!s) return;
    setHidden(menu, s.phase !== 'menu');
  }

  function syncSheet(): void {
    const s = snap;
    if (!s) return;
    sheetDifficulty.set(s.difficulty);
    sheetCoach.set(s.coachMode);
    setText(sheetCoachNote, COACH_NOTE[s.coachMode]);
    sheetSound.set(s.muted ? 'off' : 'on');
    sheetQuality.set(s.quality);
    undoBtn.disabled = !s.canUndo;
    setAttr(undoBtn, 'aria-label', s.canUndo ? 'Undo the last move' : 'Undo, unavailable');
    setText(readoutMoves, `${s.moveCount} ${s.moveCount === 1 ? 'disc' : 'discs'} played.`);
    const d = s.lastDecision;
    setText(
      readoutSearch,
      d
        ? `Last search: column ${d.column + 1}, depth ${d.depth}, ${d.nodes.toLocaleString(
            'en-GB',
          )} positions, ${Math.round(d.elapsedMs)} ms.`
        : '',
    );
  }

  /* ---------------- keyboard (§ Mac) ---------------- */

  function setSelection(col: number | null, announce: boolean): void {
    selected = col;
    hud.dispatchEvent(
      new CustomEvent(COLUMN_SELECT_EVENT, { detail: { column: col }, bubbles: true }),
    );
    if (announce && col !== null) say(`Column ${col + 1}.`);
  }

  function dropSelected(col: number): void {
    if (!snap || snap.phase !== 'playing') return;
    selected = col;
    hud.dispatchEvent(
      new CustomEvent(COLUMN_DROP_EVENT, {
        detail: { column: col, source: 'keyboard' },
        bubbles: true,
      }),
    );
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;

    if (ev.key === 'Escape') {
      if (sheetOpen) {
        ev.preventDefault();
        closeSheet();
      } else if (snap && snap.phase !== 'menu') {
        ev.preventDefault();
        cb?.onOpenMenu();
      }
      return;
    }

    if (sheetOpen || !snap || snap.phase === 'menu') return;

    // A focused control keeps Enter, Space and the arrows; the shortcuts that
    // cannot collide with a button still work from anywhere.
    const target = ev.target;
    const inControl =
      target instanceof Element && target.closest('button, input, select, textarea') !== null;

    if (ev.key === 'u' || ev.key === 'U') {
      if (snap.canUndo) {
        ev.preventDefault();
        cb?.onUndo();
      }
      return;
    }
    if (ev.key === 'r' || ev.key === 'R') {
      ev.preventDefault();
      cb?.onRestart();
      return;
    }
    if (ev.key >= '1' && ev.key <= '7') {
      const col = Number(ev.key) - 1;
      ev.preventDefault();
      setSelection(col, false);
      dropSelected(col);
      return;
    }

    if (inControl) return;

    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      const step = ev.key === 'ArrowRight' ? 1 : -1;
      const from = selected ?? (step > 0 ? -1 : COLS);
      setSelection(Math.min(COLS - 1, Math.max(0, from + step)), true);
      return;
    }
    if (ev.key === 'Enter' && selected !== null) {
      ev.preventDefault();
      dropSelected(selected);
    }
  }

  /* ---------------- Hud ---------------- */

  return {
    mount(root: HTMLElement, callbacks: HudCallbacks): void {
      cb = callbacks;
      mounted = true;
      root.appendChild(hud);
      document.addEventListener('keydown', onKeyDown);
    },

    update(snapshot: GameSnapshot): void {
      const prev = snap;
      snap = snapshot;

      // The title screen seeds itself from live state on entry only, so
      // repeated menu snapshots never fight the player's selections.
      if (snapshot.phase === 'menu' && (!prev || prev.phase !== 'menu')) {
        draft.difficulty = snapshot.difficulty;
        draft.coachMode = snapshot.coachMode;
        draft.humanPlayer = snapshot.humanPlayer;
        draft.vsAi = snapshot.vsAi;
        coachTouched = false;
        menuDifficulty.set(draft.difficulty);
        menuCoach.set(draft.coachMode);
        setText(menuCoachNote, COACH_NOTE[draft.coachMode]);
        menuOpponent.set(draft.vsAi ? 'ai' : 'human');
        menuColour.set(tintOf(draft.humanPlayer));
        if (mounted && !menuPanel.contains(document.activeElement)) menuPanel.focus();
      }

      if (snapshot.phase !== 'over' && bannerVisible) hideBannerInternal();
      if (snapshot.phase === 'menu' && sheetOpen) closeSheet(false);

      syncMenu();
      syncPlay();
      if (sheetOpen) syncSheet();
      say(announcement(snapshot));
    },

    showBanner(text: string, tone: 'win' | 'loss' | 'draw'): void {
      setAttr(banner, 'data-tone', tone);
      setText(bannerText, text);
      bannerPanel.setAttribute('aria-label', text);
      bannerVisible = true;
      setHidden(banner, false);
      setHidden(capsule, true);
      say(text);
    },

    hideBanner(): void {
      hideBannerInternal();
    },

    dispose(): void {
      document.removeEventListener('keydown', onKeyDown);
      hud.remove();
      mounted = false;
      cb = null;
      snap = null;
    },
  };
}
