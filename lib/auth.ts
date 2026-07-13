import { auth, signIn, signOut } from "@/auth";
import { db } from "@/lib/db";

/**
 * Server-side auth surface consumed by pages/route handlers. `auth` and
 * `getCurrentUser` are a stable contract for the dashboard — keep the names.
 */
export { auth, signIn, signOut };

export interface CurrentUser {
  id: string;
  spotifyId: string;
  displayName: string | null;
  email: string | null;
  imageUrl: string | null;
}

/** Resolves the signed-in user's Prisma record, or null if not authenticated. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;

  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  return {
    id: user.id,
    spotifyId: user.spotifyId,
    displayName: user.displayName,
    email: user.email,
    imageUrl: user.imageUrl,
  };
}
