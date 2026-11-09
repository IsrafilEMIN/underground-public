import { readFile } from "node:fs/promises";
import { isRecord } from "./protocol.ts";

export type FileText = { kind: "text"; text: string } | { kind: "missing" } | { kind: "unreadable" };

export async function readFileAsText(path: string): Promise<FileText> {
  try {
    return { kind: "text", text: await readFile(path, "utf8") };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable" };
  }
}
