/**
 * Device slot registration (R3) — browsers only. The desktop app and CLI
 * authenticate by bearer token and never call this; they never appear in
 * this table and therefore never hold a slot (checked by `slotForDevice`
 * returning null for them, which is exactly what makes R4's canonical-log
 * guard work for a caller that was never registered).
 */

export type DeviceRow = {
	deviceId: string;
	slot: number;
	label: string | null;
	firstSeenAt: number;
	lastSeenAt: number;
};

const FIRST_SLOT = 2;

/**
 * Assigns the next free integer slot starting at 2, or returns the
 * already-assigned slot for a repeat registration of the same device id
 * (idempotent, per R3). All reads/writes here are synchronous SQL calls with
 * no intervening `await`, so two registrations racing the same DO instance
 * can never both compute the same "next free slot" — the DO serializes them.
 */
export function registerDevice(
	sql: SqlStorage,
	deviceId: string,
	label?: string,
): DeviceRow {
	const now = Date.now();
	const existing = sql
		.exec<DeviceRow>(`SELECT * FROM devices WHERE deviceId = ?`, deviceId)
		.toArray()[0];
	if (existing) {
		sql.exec(
			`UPDATE devices SET lastSeenAt = ? WHERE deviceId = ?`,
			now,
			deviceId,
		);
		return { ...existing, lastSeenAt: now };
	}

	const maxSlotRow = sql
		.exec<{ maxSlot: number | null }>(
			`SELECT MAX(slot) as maxSlot FROM devices`,
		)
		.one();
	const nextSlot = Math.max(FIRST_SLOT, (maxSlotRow.maxSlot ?? 0) + 1);

	sql.exec(
		`INSERT INTO devices (deviceId, slot, label, firstSeenAt, lastSeenAt) VALUES (?, ?, ?, ?, ?)`,
		deviceId,
		nextSlot,
		label ?? null,
		now,
		now,
	);
	return {
		deviceId,
		slot: nextSlot,
		label: label ?? null,
		firstSeenAt: now,
		lastSeenAt: now,
	};
}

/** Returns the registered slot for a device id, or null if it was never registered (i.e. it is not a browser — desktop/CLI, per R3). */
export function slotForDevice(
	sql: SqlStorage,
	deviceId: string,
): number | null {
	const row = sql
		.exec<{ slot: number }>(
			`SELECT slot FROM devices WHERE deviceId = ?`,
			deviceId,
		)
		.toArray()[0];
	return row ? row.slot : null;
}

export function listDevices(sql: SqlStorage): DeviceRow[] {
	return sql
		.exec<DeviceRow>(`SELECT * FROM devices ORDER BY slot ASC`)
		.toArray();
}
