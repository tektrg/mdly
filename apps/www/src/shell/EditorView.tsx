import {
	EditorView as SharedEditorView,
	type WikiTarget,
	wikiDisplayNameForTarget,
} from "@mdly/workspace-kit";
import { useStoreValue } from "@simplestack/store/react";
import { loadPath, updateEditorContent } from "../store/actions";
import { filesStore } from "../store/state";
import { createWebImageExtension } from "./WebImageExtension";

type Props = {
	path: string;
	initialMarkdown: string;
};

/**
 * R31: read-only. `editable={false}` rejects direct typing at the
 * ProseMirror level and gates the kit's own save path (see EditorView's
 * `editable` doc comment in @mdly/workspace-kit). `onPaste`/`onDrop` are
 * deliberately not wired here either — the Convex-era version of this file
 * routed them to `handleImagePaste`/`handleImageDrop` to insert+upload a new
 * image; that upload entry point is a write, so it's dropped along with
 * everything else "the Mac is the sole author of notes" rules out.
 * `createWebImageExtension()` stays: it's needed to *render* images that are
 * already part of a synced note (resolves each image's authenticated
 * download URL), which is a read, not a write.
 */
export function EditorView({ path, initialMarkdown }: Props) {
	const files = useStoreValue(filesStore);
	const wikiTargets: WikiTarget[] = files.map((file) => ({
		path: file.path,
		target: file.path,
		title: wikiDisplayNameForTarget(file.path),
	}));

	return (
		<SharedEditorView
			path={path}
			initialMarkdown={initialMarkdown}
			wikiTargets={wikiTargets}
			extensions={[createWebImageExtension()]}
			editable={false}
			onLocalChange={updateEditorContent}
			onSave={() => {}}
			onOpenExternalLink={(href) => {
				window.open(href, "_blank", "noopener");
			}}
			onOpenWikiLink={(target) => void loadPath(target.split("#")[0] ?? target)}
		/>
	);
}
