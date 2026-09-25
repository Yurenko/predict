import { createRequire } from "node:module";
import type { PrismaClient as PrismaClientType } from "@prisma/client";

const { PrismaClient } = createRequire(import.meta.url)("@prisma/client") as {
  PrismaClient: new (options?: { log?: Array<"error" | "warn"> }) => PrismaClientType;
};

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClientType };

function createPrisma(): PrismaClientType {
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

function isGeneratedClient(client: PrismaClientType | undefined): client is PrismaClientType {
  return Boolean(client && (client as { recordSession?: unknown }).recordSession);
}

export const prisma = isGeneratedClient(globalForPrisma.prisma)
  ? globalForPrisma.prisma
  : createPrisma();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
