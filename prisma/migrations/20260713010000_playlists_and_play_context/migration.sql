-- AlterTable
ALTER TABLE "Play" ADD COLUMN     "incognito" BOOLEAN,
ADD COLUMN     "offline" BOOLEAN,
ADD COLUMN     "platform" TEXT;

-- CreateTable
CREATE TABLE "GeneratedPlaylist" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "spotifyPlaylistId" TEXT,
    "meta" JSONB,

    CONSTRAINT "GeneratedPlaylist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaylistItem" (
    "id" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "stat" TEXT,

    CONSTRAINT "PlaylistItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GeneratedPlaylist_userId_kind_idx" ON "GeneratedPlaylist"("userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedPlaylist_userId_kind_title_key" ON "GeneratedPlaylist"("userId", "kind", "title");

-- CreateIndex
CREATE UNIQUE INDEX "PlaylistItem_playlistId_position_key" ON "PlaylistItem"("playlistId", "position");

-- AddForeignKey
ALTER TABLE "GeneratedPlaylist" ADD CONSTRAINT "GeneratedPlaylist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaylistItem" ADD CONSTRAINT "PlaylistItem_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "GeneratedPlaylist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaylistItem" ADD CONSTRAINT "PlaylistItem_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

