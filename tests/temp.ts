import { mkdtemp, realpath } from "node:fs/promises";

export async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(prefix));
}
