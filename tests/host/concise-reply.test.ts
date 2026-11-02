import assert from "node:assert/strict";
import { test } from "node:test";
import { isReminderDue } from "../../host/roles/hooks/pre/concise-reply.ts";

const user = { type: "message", message: { role: "user" } };
const assistant = { type: "message", message: { role: "assistant" } };
const reminder = { type: "custom_message", customType: "concise-reply" };

function afterReminder(answeredPrompts: number) {
  return [user, reminder, assistant, ...Array.from({ length: answeredPrompts }, () => [user, assistant]).flat()];
}

test("the first prompt of a session gets the reminder, whether or not omp saved the prompt before the hook runs", () => {
  assert.equal(isReminderDue([]), true);
  assert.equal(isReminderDue([user]), true);
});

test("the reminder comes back on every tenth prompt, whether or not omp saved the current prompt before the hook runs", () => {
  for (const savedFirst of [false, true]) {
    const branch = (answered: number) => [...afterReminder(answered), ...(savedFirst ? [user] : [])];
    assert.equal(isReminderDue(branch(0)), false, `prompt 2, saved first: ${savedFirst}`);
    assert.equal(isReminderDue(branch(8)), false, `prompt 10, saved first: ${savedFirst}`);
    assert.equal(isReminderDue(branch(9)), true, `prompt 11, saved first: ${savedFirst}`);
  }
});
