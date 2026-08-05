import { NewNoteButton, Toolbar as SharedToolbar } from "@mdly/workspace-kit";
import { useStoreValue } from "@simplestack/store/react";
import { currentPathStore } from "../store/state";

type Props = {
	onNewNote: () => void;
};

export function Toolbar({ onNewNote }: Props) {
	const currentPath = useStoreValue(currentPathStore);

	return (
		<SharedToolbar
			currentPath={currentPath ?? null}
			sidebarOpen
			platformInset={false}
			rightSlot={<NewNoteButton onClick={onNewNote} />}
		/>
	);
}
