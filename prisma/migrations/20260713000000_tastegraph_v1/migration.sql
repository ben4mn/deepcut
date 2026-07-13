-- AlterTable
ALTER TABLE "Play" ADD COLUMN     "sessionId" TEXT;

-- CreateTable
CREATE TABLE "ListenerProfile" (
    "userId" TEXT NOT NULL,
    "restlessness" DOUBLE PRECISION NOT NULL,
    "decisionDensity" DOUBLE PRECISION NOT NULL,
    "shuffleSurrender" DOUBLE PRECISION NOT NULL,
    "coldOpenTolerance" DOUBLE PRECISION NOT NULL,
    "deadZones" JSONB NOT NULL,
    "completionMultiplier" DOUBLE PRECISION NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListenerProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "TrackLifecycle" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "firstPlayAt" TIMESTAMP(3) NOT NULL,
    "lastPlayAt" TIMESTAMP(3) NOT NULL,
    "lifetimePlays" INTEGER NOT NULL,
    "lifetimeMs" BIGINT NOT NULL,
    "pulseScore" DOUBLE PRECISION NOT NULL,
    "seasonScore" DOUBLE PRECISION NOT NULL,
    "coreScore" DOUBLE PRECISION NOT NULL,
    "intensityPct" DOUBLE PRECISION NOT NULL,
    "durability" DOUBLE PRECISION NOT NULL,
    "quadrant" TEXT NOT NULL,
    "curveShape" TEXT,
    "heartbeatCv" DOUBLE PRECISION,
    "peakRate28d" DOUBLE PRECISION NOT NULL,
    "currentRate28d" DOUBLE PRECISION NOT NULL,
    "burned" BOOLEAN NOT NULL DEFAULT false,
    "cooldownUntil" TIMESTAMP(3),
    "resurrectionEligible" BOOLEAN NOT NULL DEFAULT false,
    "honeymoonSlope" DOUBLE PRECISION,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackLifecycle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrackLifecycle_userId_quadrant_idx" ON "TrackLifecycle"("userId", "quadrant");

-- CreateIndex
CREATE INDEX "TrackLifecycle_userId_coreScore_idx" ON "TrackLifecycle"("userId", "coreScore" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "TrackLifecycle_userId_trackId_key" ON "TrackLifecycle"("userId", "trackId");

-- CreateIndex
CREATE INDEX "Play_userId_sessionId_idx" ON "Play"("userId", "sessionId");

-- AddForeignKey
ALTER TABLE "ListenerProfile" ADD CONSTRAINT "ListenerProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackLifecycle" ADD CONSTRAINT "TrackLifecycle_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackLifecycle" ADD CONSTRAINT "TrackLifecycle_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

