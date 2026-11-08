import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), basename(prefix))));
}
