// omp loads this hook from the owner part of the omp root, omp/agent/hooks/pre, for every
// session and its subagents. The wrapper gives the main session the rules of its role with
// --append-system-prompt, but omp does not pass that text to task subagents. So for a
// subagent this hook appends the same file, which the wrapper names in UG_ROLE_RULES, to
// the system prompt of each turn.
import { readFileSync } from "node:fs";

type Context = { agent?: { kind: "main" | "sub" } };
type HookApi = {
  on(event: "before_agent_start", handler: (event: { systemPrompt: string[] }, ctx: Context) => { systemPrompt: string[] } | undefined): void;
};

export default function roleRules(pi: HookApi): void {
  pi.on("before_agent_start", (event, ctx) => {
    const file = process.env.UG_ROLE_RULES;
    if (ctx.agent?.kind !== "sub" || file === undefined || file === "") return undefined;
    return { systemPrompt: [...event.systemPrompt, readFileSync(file, "utf8")] };
  });
}
