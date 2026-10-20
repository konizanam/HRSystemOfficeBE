-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mfaEnabledAt" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "MobilePairingToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MobilePairingToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MobilePairingToken_tokenHash_key" ON "MobilePairingToken"("tokenHash");

-- CreateIndex
CREATE INDEX "MobilePairingToken_userId_idx" ON "MobilePairingToken"("userId");

-- AddForeignKey
ALTER TABLE "MobilePairingToken" ADD CONSTRAINT "MobilePairingToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
