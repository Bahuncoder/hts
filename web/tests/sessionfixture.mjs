import crypto from "node:crypto";

// Independently compute the persisted session digest for test fixtures.
export const sessionTokenHash = token => `sha256:${crypto.createHash("sha256").update(token).digest("hex")}`;
