import { logout } from "@mdly/cloudflare-client";
import { useStoreValue } from "@simplestack/store/react";
import {
	BrowserRouter,
	Navigate,
	Route,
	Routes,
	useNavigate,
	useParams,
} from "react-router";
import { readLastWorkspaceId, saveWorkspace } from "./connection/connection";
import { WORKER_BASE_URL } from "./connection/workerUrl";
import { LoginScreen } from "./screens/LoginScreen";
import { WorkspacePickerScreen } from "./screens/WorkspacePickerScreen";
import { AppShell } from "./shell/AppShell";
import {
	authStore,
	markAuthenticated,
	markUnauthenticated,
} from "./store/authState";
import { workspaceStore } from "./store/state";

export default function App() {
	return (
		<BrowserRouter>
			<AppGate />
		</BrowserRouter>
	);
}

/**
 * D6/D8: replaces the old Convex-era "connect to a URL, then open a
 * workspace" flow with a plain auth gate. `authStore` starts optimistic
 * (assume the session cookie is still valid) — the first request any screen
 * makes will flip it to "unauthenticated" on a real 401, which is the signal
 * to show the login screen instead.
 */
function AppGate() {
	const authStatus = useStoreValue(authStore);

	if (authStatus === "unauthenticated") {
		return <LoginScreen onLoggedIn={markAuthenticated} />;
	}

	return <AppRoutes />;
}

function AppRoutes() {
	const navigate = useNavigate();

	const handleLogout = async () => {
		try {
			await logout(WORKER_BASE_URL);
		} finally {
			markUnauthenticated();
		}
	};

	const handleWorkspaceSelected = (workspaceId: string) => {
		saveWorkspace(workspaceId);
		navigate(workspaceRoute(workspaceId));
	};

	return (
		<Routes>
			<Route
				path="/"
				element={
					<HomeRoute
						onSelected={handleWorkspaceSelected}
						onLogout={handleLogout}
					/>
				}
			/>
			<Route
				path="/w/:workspaceId"
				element={
					<WorkspaceRoute
						filePath={null}
						onSwitch={handleWorkspaceSelected}
						onLogout={handleLogout}
					/>
				}
			/>
			<Route
				path="/w/:workspaceId/f/*"
				element={
					<WorkspaceRoute
						onSwitch={handleWorkspaceSelected}
						onLogout={handleLogout}
					/>
				}
			/>
			<Route path="*" element={<Navigate to="/" replace />} />
		</Routes>
	);
}

function HomeRoute({
	onSelected,
	onLogout,
}: {
	onSelected: (workspaceId: string) => void;
	onLogout: () => void;
}) {
	const lastWorkspaceId = readLastWorkspaceId();
	if (lastWorkspaceId) {
		const lastOpenedPath =
			workspaceStore.get().lastOpenedPaths[lastWorkspaceId];
		return (
			<Navigate
				to={
					lastOpenedPath
						? workspaceFileRoute(lastWorkspaceId, lastOpenedPath)
						: workspaceRoute(lastWorkspaceId)
				}
				replace
			/>
		);
	}

	return (
		<WorkspacePickerScreen
			onSelected={onSelected}
			onUnauthorized={markUnauthenticated}
			onLogout={onLogout}
		/>
	);
}

function WorkspaceRoute({
	filePath,
	onSwitch,
	onLogout,
}: {
	filePath?: string | null;
	onSwitch: (id: string) => void;
	onLogout: () => void;
}) {
	const params = useParams();
	const navigate = useNavigate();
	const workspaceId = params.workspaceId;
	const routeFilePath =
		filePath === undefined ? (params["*"] ?? null) : filePath;

	if (!workspaceId) return <Navigate to="/" replace />;

	return (
		<AppShell
			workspaceId={workspaceId}
			filePath={routeFilePath}
			onSelectFile={(path) => {
				navigate(workspaceFileRoute(workspaceId, path));
			}}
			onSwitch={onSwitch}
			onUnauthorized={markUnauthenticated}
			onLogout={onLogout}
		/>
	);
}

function workspaceRoute(workspaceId: string): string {
	return `/w/${encodeURIComponent(workspaceId)}`;
}

function workspaceFileRoute(workspaceId: string, path: string): string {
	return `${workspaceRoute(workspaceId)}/f/${path
		.split("/")
		.map(encodeURIComponent)
		.join("/")}`;
}
