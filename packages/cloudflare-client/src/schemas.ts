import { z } from "zod/v4";

/**
 * Zod schemas for every Worker response shape this client reads (R9). Kept
 * in one file, one schema per route family, so "what the Worker is allowed
 * to send back" is legible in one place rather than scattered across each
 * method's implementation.
 */

export const RemoteFileSchema = z.object({
	_id: z.string(),
	path: z.string(),
	contentHash: z.string(),
	content: z.string(),
	updatedAt: z.number(),
	deviceId: z.string(),
	deleted: z.boolean(),
});

export const RemoteAssetSchema = z.object({
	_id: z.string(),
	path: z.string(),
	storageId: z.string(),
	contentHash: z.string(),
	updatedAt: z.number(),
	deviceId: z.string(),
	deleted: z.boolean(),
});

export const PageCursorSchema = z.object({
	updatedAt: z.number(),
	path: z.string(),
});

export const GetFilesResponseSchema = z.object({
	files: z.array(RemoteFileSchema),
	// Absent on old servers / mocks that return the full list at once —
	// missing means "no further pages".
	nextCursor: PageCursorSchema.nullish(),
});

export const GetAssetsResponseSchema = z.object({
	assets: z.array(RemoteAssetSchema),
	nextCursor: PageCursorSchema.nullish(),
});

export const MutationOkResponseSchema = z.object({
	ok: z.literal(true),
	version: z.number(),
});

/** GET /api/version — the cheap 1-row "did anything change?" check. */
export const VersionResponseSchema = z.object({
	version: z.number(),
});

export const WorkspaceIdResponseSchema = z.object({
	workspaceId: z.string().nullable(),
});

export const CreateWorkspaceResponseSchema = z.object({
	workspaceId: z.string(),
});

export const UploadUrlResponseSchema = z.object({
	uploadUrl: z.string(),
});

export const DownloadUrlResponseSchema = z.object({
	url: z.string().nullable(),
});

export const RegisterDeviceResponseSchema = z.object({
	slot: z.number(),
});

export const WorkspaceSummarySchema = z.object({
	workspaceId: z.string(),
	name: z.string(),
});

export const ListWorkspacesResponseSchema = z.object({
	workspaces: z.array(WorkspaceSummarySchema),
});

export const DeleteWorkspaceResponseSchema = z.object({
	ok: z.literal(true),
});

/** The WebSocket broadcast payload (apps/www/worker/durableObject/broadcast.ts's `VersionBroadcastMessage`). */
export const VersionMessageSchema = z.object({
	type: z.literal("version"),
	version: z.number(),
});
