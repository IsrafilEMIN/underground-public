import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

const SRC = join(import.meta.dirname, "../..");

test("the box image tag is the same in the owner's terminal and in a launchd job, whatever the language setting", () => {
  const tags = ["C", "en_US.UTF-8", "de_DE.UTF-8"].map((locale) => {
    const r = spawnSync("bash", ["-c", `source host/lib/box-image.bash && box_image_tag "$PWD"`], {
      cwd: SRC,
      env: { PATH: "/usr/bin:/bin", LC_ALL: locale, LANG: locale },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  });
  assert.match(tags[0], /^ugbox:[0-9a-f]{16}$/);
  assert.deepEqual(new Set(tags).size, 1, tags.join(" "));
});
