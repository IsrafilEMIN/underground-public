// omp loads this hook from the owner part of the omp root, omp/agent/hooks/pre,
// for every session and for its subagents. On the first user prompt of a session,
// and then on every tenth prompt, it adds one reminder message, which omp saves to
// the session. The reminder then stays at the same place in the history, so the
// text before each signed thinking block does not change from one model call to
// the next. The hook counts prompts from the saved session, not in memory, so a
// retry of the same prompt and a resumed session count the same way.
const INTERVAL = 10;

const CUSTOM_TYPE = "concise-reply";

const REMINDER =
  "These rules shape the text of your reply only; they never decide whether you keep working. If a task is open, or the user reports the result of a step you gave them (\"done\", \"ran it\", \"it printed nothing\"), take that as the go-ahead and continue the task with tools before you reply. When you ask the user to run something, end with one line that says what you will do next once they confirm. When you do reply: answer first, in one or two sentences. Use plain words, like one person talking to another. Leave out paths, hashes, and tool names unless the user needs one to act. Follow the user's own style rules, such as all lowercase, in every reply. Add only what the user needs to act on or to check the answer, risks included. Do not repeat what this chat already said. Name a source (file:line, command output, or a doc URL with the read date) only for a claim the user may want to check; say plainly when a claim is a guess. Skip background and edge cases unless the user asks. Stop writing once the answer is given. Do not add: facts next to the question but not asked for; how you found things; a point made twice; a claim wider than its source; a closing summary; nested bullets. Write connected sentences; use bullets only for a real list, at most five unless the ask is a list. If something was not checked, say so in one line. If the user asks again for a simpler or shorter version of a reply, give it, and say once that these reply rules are not landing, so the owner can fix them.";

type Entry = { type: string; customType?: string; message?: { role: string } };

type HookContext = { sessionManager: { getBranch(): Entry[] } };

type Reminder = { customType: string; content: string; display: boolean; attribution: "agent" };

type HookApi = {
  on(event: "before_agent_start", handler: (event: unknown, ctx: HookContext) => { message: Reminder } | undefined): void;
};

function promptsSinceReminder(branch: Entry[]): number | undefined {
  let prompts = 0;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom_message" && entry.customType === CUSTOM_TYPE) return prompts;
    if (entry.type === "compaction") return undefined;
    if (entry.type === "message" && entry.message?.role === "user") prompts++;
  }
  return undefined;
}

export function isReminderDue(branch: Entry[]): boolean {
  const since = promptsSinceReminder(branch);
  if (since === undefined) return true;
  const last = branch.at(-1);
  const current = last?.type === "message" && last.message?.role === "user" ? 1 : 0;
  return since - current >= INTERVAL - 1;
}

export default function conciseReply(pi: HookApi): void {
  pi.on("before_agent_start", (_event, ctx) =>
    isReminderDue(ctx.sessionManager.getBranch())
      ? { message: { customType: CUSTOM_TYPE, content: REMINDER, display: false, attribution: "agent" } }
      : undefined,
  );
}
