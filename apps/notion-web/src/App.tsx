import { useEffect, useState } from "react";
import { getSessionStatus } from "./api/client";
import { ConnectScreen } from "./screens/ConnectScreen";
import { AppShell } from "./shell/AppShell";
import type { SessionStatus } from "./notion/types";

type LoadState =
	| { status: "loading" }
	| { status: "ready"; session: SessionStatus };

export function App() {
	const [state, setState] = useState<LoadState>({ status: "loading" });

	useEffect(() => {
		let cancelled = false;
		getSessionStatus()
			.then((session) => {
				if (!cancelled) setState({ status: "ready", session });
			})
			.catch(() => {
				if (!cancelled) {
					setState({
						status: "ready",
						session: {
							connected: false,
							configured: false,
							workspaceName: null,
							workspaceIcon: null,
						},
					});
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	if (state.status === "loading") {
		return (
			<div className="flex h-full items-center justify-center text-sm opacity-60">
				Loading…
			</div>
		);
	}

	if (!state.session.connected) {
		return <ConnectScreen session={state.session} />;
	}

	return <AppShell session={state.session} />;
}
