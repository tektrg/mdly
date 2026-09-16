/**
 * The top band of the window belongs to the window chrome, not to page content.
 *
 * `.desktop-window-drag-strip` (index.css) is a `position: fixed`, `z-10`,
 * `2.75rem`-tall `-webkit-app-region: drag` overlay, and both floating pills
 * live inside it: the note-actions pill (`Toolbar`, `fixed end-3 top-3`) and the
 * show-sidebar pill (`App`, same top, inline-start at the traffic-light inset).
 * `Toolbar` renders only fixed content, so the first in-flow child of `<main>`
 * starts at y=0 — underneath all three.
 *
 * Any header that puts controls up there loses them: the pills paint over it,
 * and Chromium resolves `-webkit-app-region` by paint order, so a `no-drag`
 * control below the strip is not reliably clickable at all. Reserving the band
 * is the fix the rest of the app already uses (`Sidebar.tsx`), and it needs no
 * stacking-context tricks.
 *
 * `max()` of two independent constraints:
 * - `2.75rem` — the drag strip's own height, which is also where both pills end.
 * - the traffic-light inset — what `Sidebar.tsx` reserves, so a zoom level that
 *   pushes the macOS window buttons lower pushes this header down with them.
 *
 * Logical property (`padding-block-start`), per the repo's spacing rule.
 */
export const WINDOW_CHROME_INSET_CLASS =
	"[padding-block-start:max(2.75rem,calc(var(--hubble-traffic-light-top-inset,0px)+0.375rem))]";
