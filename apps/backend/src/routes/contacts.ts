/**
 * Contacts routes — PERM-2.3 authenticated contact matching.
 *
 * All routes require a valid JWT access token (requireAuth middleware).
 * Privacy-preserving: receives ONLY SHA-256 hashes of E.164 numbers.
 * Raw phone numbers are NEVER sent or logged.
 */

import { Router, Request, Response } from "express";
import { inArray, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { contactHashes } from "../db/contact-hashes-schema.js";
import { users } from "../db/users-schema.js";
import { requireAuth } from "../middleware/auth.js";

const router: Router = Router();

router.use(requireAuth);

const MAX_BATCH_SIZE = 1000;
const HASH_REGEX = /^[a-f0-9]{64}$/;

router.post("/match", async (req: Request, res: Response) => {
  try {
    const { hashes } = req.body as { hashes?: string[] };

    if (!hashes || !Array.isArray(hashes)) {
      res.status(400).json({ error: "hashes array is required" });
      return;
    }

    if (hashes.length > MAX_BATCH_SIZE) {
      res.status(400).json({ error: "BATCH_TOO_LARGE", max: MAX_BATCH_SIZE });
      return;
    }

    for (const h of hashes) {
      if (typeof h !== "string" || !HASH_REGEX.test(h)) {
        res.status(400).json({ error: "INVALID_HASH" });
        return;
      }
    }

    if (hashes.length === 0) {
      res.json({ matches: [] });
      return;
    }

    const db = getDb();

    // Query matched contact hashes and join with users to return registered profile data
    const matchedUsers = await db
      .select({
        id: users.id,
        name: users.name,
        photo: users.photo,
        about: users.about,
      })
      .from(contactHashes)
      .innerJoin(users, eq(contactHashes.userId, users.id))
      .where(inArray(contactHashes.phoneHash, hashes));

    res.json({
      matches: matchedUsers.map((u) => ({
        id: u.id,
        name: u.name,
        photo: u.photo ?? undefined,
        about: u.about ?? "",
      })),
    });
  } catch (error) {
    console.error("POST /contacts/match error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
