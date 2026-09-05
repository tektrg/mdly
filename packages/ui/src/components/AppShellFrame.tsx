import type { ReactNode } from "react";

export function AppShellFrame({
	toolbar,
	sidebar,
	children,
	mobileNavOpen = false,
	onCloseMobileNav,
}: {
	toolbar: ReactNode;
	sidebar?: ReactNode;
	children: ReactNode;
	/** Below the `md` breakpoint, `sidebar` renders as a slide-in drawer instead of in-flow; ignored at `md` and up, where it's always shown in-flow as before. */
	mobileNavOpen?: boolean;
	onCloseMobileNav?: () => void;
}) {
	return (
		<main className="flex h-dvh flex-col bg-background text-foreground">
			{toolbar}
			<div className="flex min-h-0 flex-1 overflow-hidden">
				{sidebar && (
					<>
						{mobileNavOpen && (
							<div
								className="fixed inset-0 z-30 bg-black/40 md:hidden"
								onClick={onCloseMobileNav}
								aria-hidden="true"
							/>
						)}
						<div
							className={`z-40 h-full shrink-0 md:static md:z-auto md:flex md:w-auto md:max-w-none md:shadow-none ${
								mobileNavOpen
									? "fixed inset-y-0 start-0 flex w-72 max-w-[85vw] shadow-xl"
									: "hidden"
							}`}
						>
							{sidebar}
						</div>
					</>
				)}
				<section className="flex-1 overflow-hidden" aria-live="polite">
					{children}
				</section>
			</div>
		</main>
	);
}
