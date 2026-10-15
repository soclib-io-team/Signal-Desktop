// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Only locally authored, user-facing messages may cross the IPC boundary.
export class RosterError extends Error {}
