import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { userProfiles } from "@/db/schema";

export const updateUserPreferences = async (
  userId: string,
  preferences: { autoAssignOnTicketAction?: boolean; confetti?: boolean; disableNextTicketPreview?: boolean },
) => {
  await db
    .update(userProfiles)
    .set({ preferences: sql`coalesce(preferences, '{}')::jsonb || ${JSON.stringify(preferences)}::jsonb` })
    .where(eq(userProfiles.id, userId));
};
