// Lets a host opt a themed wrapping element in as the mount target for every
// popup/menu/dialog the kit renders (Sidebar's context menu and sort
// dropdown, the code-block language picker, the file-properties type picker,
// the workspace-switcher menu, and the shared fullscreen Modal). See the ADR
// (docs/architecture/adr-workspace-kit-package-boundary.md, Decision 2) and
// Phase 2 charter R11-R13/R27.
//
// Default context value is `undefined`, deliberately never `null`:
// base-ui's `FloatingPortal` (which every base-ui `*.Portal` in this kit
// wraps) resolves a `container` of `undefined` as "fall through to
// `parentPortalNode ?? document.body`" -- i.e. exactly today's behavior for
// every existing consumer that doesn't opt in (R12). A `container` of
// `null` instead means "the container isn't ready yet, don't render the
// popup at all" -- passing that as the no-provider default would silently
// break every popup in every app that doesn't use this provider.
import * as React from "react";

const PortalContainerContext = React.createContext<HTMLElement | undefined>(
	undefined,
);

if (process.env.NODE_ENV !== "production") {
	PortalContainerContext.displayName = "PortalContainerContext";
}

export interface PortalContainerProviderProps {
	/**
	 * The element popups should mount inside of once it exists. Pass `null`
	 * while the wrapper hasn't mounted yet (e.g. the initial value of a
	 * `useState` paired with a ref callback) -- popups keep defaulting to
	 * `document.body` until a real element is supplied, then pick up the new
	 * container automatically on the next render (R27). Never thread a plain
	 * `useRef().current` read taken during render here -- that value is `null`
	 * on first render and never updates, which would freeze every popup on
	 * `document.body` forever despite the wiring looking correct in source.
	 */
	container: HTMLElement | null;
	children: React.ReactNode;
}

/**
 * Provides the mount target every base-ui `*.Portal` call site in the kit
 * reads via `usePortalContainer()`. Opt-in only -- an app that renders the
 * kit's components without this provider gets `undefined` from
 * `usePortalContainer()`, which is exactly the "no target set" default every
 * popup already falls back to (R12).
 */
export function PortalContainerProvider({
	container,
	children,
}: PortalContainerProviderProps) {
	const value = container ?? undefined;
	return (
		<PortalContainerContext.Provider value={value}>
			{children}
		</PortalContainerContext.Provider>
	);
}

/**
 * Reads the current portal mount target, if any. Returns `undefined` when no
 * `PortalContainerProvider` is present, or when its `container` prop hasn't
 * resolved to a real element yet -- in both cases the caller should still
 * pass this straight through to a base-ui `*.Portal`'s `container` prop,
 * since `undefined` is exactly the "use the default" signal that primitive
 * already understands.
 */
export function usePortalContainer(): HTMLElement | undefined {
	return React.useContext(PortalContainerContext);
}
