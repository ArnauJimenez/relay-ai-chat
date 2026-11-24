-- AlterTable
ALTER TABLE "Room" ADD COLUMN "directKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Room_directKey_key" ON "Room"("directKey");
