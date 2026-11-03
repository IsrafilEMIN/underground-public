import { handleRequest } from "../../host/broker/server.ts";
import type { ServerConfig } from "../../host/broker/server.ts";
import type { Reply } from "../../host/broker/protocol.ts";

// One socket serves every session, and a review names its reviewer role in the request
// (docs/adr/0011-one-agent-arena.md). A test session holds only the role that fills that field.
export type Session = { role: string };

export function handleAs(config: ServerConfig, session: Session, input: unknown, signal: AbortSignal): Promise<Reply> {
  const isReview = typeof input === "object" && input !== null && (input as Record<string, unknown>).verb === "review";
  return handleRequest(config, isReview ? { ...(input as Record<string, unknown>), role: session.role } : input, signal);
}
