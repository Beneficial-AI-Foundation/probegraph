/**
 * Fold buttons for the two sidebars.
 *
 * A folded sidebar shrinks to a thin strip that holds only its button, so the
 * graph gets the space. The state of each side is kept in localStorage, and
 * `[` and `]` toggle the left and right side when no text field has the focus.
 */
import { isTextField } from './search-box';

export type Side = 'left' | 'right';

const STORAGE_KEY = 'probegraph.foldedSidebars';
const KEYS: Record<string, Side> = { '[': 'left', ']': 'right' };
const NAMES: Record<Side, string> = { left: 'filters', right: 'details' };

/** Reads the folded sides from storage; storage can be absent, as in some webviews. */
function loadFolded(): Set<Side> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return new Set((Array.isArray(raw) ? raw : []).filter((s): s is Side => s === 'left' || s === 'right'));
  } catch {
    return new Set();
  }
}

function saveFolded(folded: Set<Side>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...folded]));
  } catch {
    // No storage: the state lasts for this page only
  }
}

/**
 * Sets up both fold buttons. `onResize` runs after a side folds or unfolds,
 * when the graph container has its new size.
 */
export function setupSidebarFolds(onResize: () => void): void {
  const folded = loadFolded();

  const apply = (side: Side): void => {
    const aside = document.getElementById(`sidebar-${side}`);
    const button = document.getElementById(`fold-${side}`);
    if (!aside || !button) return;
    const isFolded = folded.has(side);
    aside.classList.toggle('folded', isFolded);
    button.setAttribute('aria-expanded', String(!isFolded));
    const key = side === 'left' ? '[' : ']';
    button.title = `${isFolded ? 'Show' : 'Fold'} the ${NAMES[side]} panel (${key})`;
    // The icon points the way the panel moves
    const icon = button.querySelector('.sidebar-fold-icon');
    if (icon) icon.textContent = (side === 'left') === isFolded ? '›' : '‹';
  };

  const toggle = (side: Side): void => {
    if (folded.has(side)) folded.delete(side); else folded.add(side);
    saveFolded(folded);
    apply(side);
    onResize();
  };

  for (const side of ['left', 'right'] as const) {
    apply(side);
    document.getElementById(`fold-${side}`)?.addEventListener('click', () => toggle(side));
  }

  document.addEventListener('keydown', e => {
    const side = KEYS[e.key];
    if (!side || e.ctrlKey || e.metaKey || e.altKey || isTextField(e.target)) return;
    e.preventDefault();
    toggle(side);
  });
}
