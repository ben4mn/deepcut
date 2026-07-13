import NextAuth, { type DefaultSession } from "next-auth";
import Spotify from "next-auth/providers/spotify";
// Side-effect import so the `next-auth/jwt` module augmentation below resolves.
import "next-auth/jwt";
import { db } from "@/lib/db";
import { encryptToken } from "@/lib/crypto";
import { refreshSpotifyToken } from "@/lib/spotify";

/**
 * Auth.js v5 (next-auth@beta) config. JWT session strategy — we keep our own
 * Prisma User/SpotifyAccount rows (so the worker can act on tokens out-of-band)
 * rather than using a DB session adapter.
 */

const SPOTIFY_SCOPES = [
  "user-read-email",
  "user-read-private",
  "user-read-recently-played",
  "user-top-read",
  "playlist-modify-private",
  "playlist-modify-public",
].join(" ");

// Refresh a little before the JWT-tracked expiry to avoid racing the API.
const JWT_REFRESH_SKEW_MS = 60 * 1000;

interface SpotifyProfile {
  id: string;
  display_name?: string | null;
  email?: string | null;
  images?: Array<{ url: string }>;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.AUTH_SECRET,
  trustHost: true,
  session: { strategy: "jwt" },
  providers: [
    Spotify({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      // Spotify supports PKCE; pair it with state for CSRF protection.
      checks: ["pkce", "state"],
      authorization: {
        params: { scope: SPOTIFY_SCOPES },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account, profile }) {
      // Initial sign-in: persist our own User + SpotifyAccount rows.
      if (account && profile) {
        const p = profile as SpotifyProfile;
        const spotifyId = p.id;
        const email = p.email ?? null;
        const displayName = p.display_name ?? null;
        const imageUrl = p.images?.[0]?.url ?? null;

        const user = await db.user.upsert({
          where: { spotifyId },
          create: { spotifyId, email, displayName, imageUrl },
          update: { email, displayName, imageUrl },
        });

        const accessToken = account.access_token ?? "";
        const refreshToken = account.refresh_token ?? "";
        const expiresAt = account.expires_at
          ? account.expires_at * 1000
          : Date.now() + 3600 * 1000;
        const scope = account.scope ?? SPOTIFY_SCOPES;

        await db.spotifyAccount.upsert({
          where: { userId: user.id },
          create: {
            userId: user.id,
            accessTokenEnc: encryptToken(accessToken),
            refreshTokenEnc: encryptToken(refreshToken),
            expiresAt: new Date(expiresAt),
            scope,
          },
          update: {
            accessTokenEnc: encryptToken(accessToken),
            refreshTokenEnc: encryptToken(refreshToken),
            expiresAt: new Date(expiresAt),
            scope,
          },
        });

        token.userId = user.id;
        token.spotifyId = spotifyId;
        token.accessToken = accessToken;
        token.refreshToken = refreshToken;
        token.expiresAt = expiresAt;
        return token;
      }

      // Still valid — hand it back as-is.
      if (typeof token.expiresAt === "number" && Date.now() < token.expiresAt - JWT_REFRESH_SKEW_MS) {
        return token;
      }

      // Expired: refresh and mirror the rotated tokens into the DB so the worker
      // sees them too.
      if (typeof token.refreshToken === "string" && token.refreshToken) {
        try {
          const refreshed = await refreshSpotifyToken(token.refreshToken);
          const newRefresh = refreshed.refreshToken ?? token.refreshToken;
          token.accessToken = refreshed.accessToken;
          token.refreshToken = newRefresh;
          token.expiresAt = refreshed.expiresAt;
          delete token.error;

          if (typeof token.userId === "string") {
            await db.spotifyAccount.update({
              where: { userId: token.userId },
              data: {
                accessTokenEnc: encryptToken(refreshed.accessToken),
                refreshTokenEnc: encryptToken(newRefresh),
                expiresAt: new Date(refreshed.expiresAt),
                ...(refreshed.scope ? { scope: refreshed.scope } : {}),
              },
            });
          }
        } catch (err) {
          console.error("[auth] token refresh failed:", err);
          token.error = "RefreshTokenError";
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = (token.userId as string) ?? "";
        session.user.spotifyId = (token.spotifyId as string) ?? "";
      }
      return session;
    },
  },
});

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      spotifyId: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    spotifyId?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    error?: string;
  }
}
