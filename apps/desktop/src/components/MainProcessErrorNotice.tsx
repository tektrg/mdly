import { useEffect } from "react";
import { toast } from "sonner";
import { desktopApi } from "../desktopApi";

/**
 * F3: in-app notice for unexpected main-process faults. The main process
 * logs the full detail to crash-trace and keeps running; this surfaces a
 * dismissible error toast so the fault is visible without freezing the app.
 * The toast id is the fault key, so a repeating fault updates the one notice
 * instead of stacking duplicates. Mounted once at the app root.
 */
export function MainProcessErrorNotice() {
	useEffect(() => {
		const dispose = desktopApi.onMainProcessError((payload) => {
			toast.error("A background problem occurred", {
				id: `main-process-error-${payload.key}`,
				description: `${payload.message} The app is still usable — technical details were saved to the diagnostic log.`,
				// A real fault, not transient status: stays until dismissed.
				// closeButton is per-toast so no other toast in the app changes.
				duration: Number.POSITIVE_INFINITY,
				closeButton: true,
			});
		});
		return () => {
			dispose();
		};
	}, []);
	return null;
}
