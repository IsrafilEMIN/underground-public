import { mkdtemp, realpath } from "node:fs/promises";

// macOS TMPDIR sits under /var, a symlink to /private/var, and git and the code report resolved paths.
export async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(prefix));
}
