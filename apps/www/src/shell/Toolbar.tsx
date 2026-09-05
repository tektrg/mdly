import { Button } from "@hubble.md/ui";
import { Toolbar as SharedToolbar } from "@mdly/workspace-kit";
import { useStoreValue } from "@simplestack/store/react";
import MingcuteLayoutLeftLine from "~icons/mingcute/layout-left-line";
import { currentPathStore } from "../store/state";

/**
 * R31: no "new note" affordance — the Mac is the sole author of notes, so
 * apps/www never has a save-triggering entry point to gate. (Compare the
 * Convex-era version of this file, which rendered a `NewNoteButton` in
 * `rightSlot`.)
 */
export function Toolbar({ onOpenMobileNav }: { onOpenMobileNav: () => void }) {
	const currentPath = useStoreValue(currentPathStore);

	return (
		<SharedToolbar
			currentPath={currentPath ?? null}
			sidebarOpen
			platformInset={false}
			leftSlot={
				<Button
					variant="ghost"
					size="icon-sm"
					className="md:hidden"
					aria-label="Open menu"
					title="Open menu"
					onClick={onOpenMobileNav}
				>
					<MingcuteLayoutLeftLine className="size-4" />
				</Button>
			}
		/>
	);
}
