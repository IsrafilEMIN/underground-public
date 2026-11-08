import { handleRequest } from "../../host/gh-broker/server.ts";
import type { ServerConfig } from "../../host/gh-broker/server.ts";
import type { Reply } from "../../host/gh-broker/protocol.ts";

export type Session = { role: string };

export function handleAs(config: ServerConfig, session: Session, input: unknown, signal: AbortSignal): Promise<Reply> {
  const isReview = typeof input === "object" && input !== null && (input as Record<string, unknown>).verb === "review";
  return handleRequest(config, isReview ? { ...(input as Record<string, unknown>), role: session.role } : input, signal);
}
