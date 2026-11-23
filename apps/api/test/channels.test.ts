import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NotConfiguredChannel, NotConfiguredError, PLACEHOLDER_ENV, type ExternalConnection } from "../src/channels";

// Integration placeholders: the seam is visible, nothing is wired, and the doc, .env.example and code agree.

const root = path.resolve(import.meta.dirname, "../../..");
const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");
const doc = fs.readFileSync(path.join(root, "docs/INTEGRATION_PLACEHOLDERS.md"), "utf8");
const all = Object.keys(PLACEHOLDER_ENV) as ExternalConnection[];

describe("integration placeholders", () => {
  it("every connection throws 'not configured in this demo'", async () => {
    expect(all).toHaveLength(12);
    for (const c of all) {
      const ch = new NotConfiguredChannel(c);
      expect(ch.configured).toBe(false);
      await expect(ch.send({ to: "x" }), c).rejects.toBeInstanceOf(NotConfiguredError);
      await expect(ch.send({}), c).rejects.toThrow(/not configured in this demo/);
    }
  });

  it("every env name is a PLACEHOLDER_, commented out in .env.example, listed in the doc, and never read by the app", () => {
    const src = fs.readdirSync(path.join(root, "apps/api/src"), { recursive: true }).map(String).filter((f) => f.endsWith(".ts") && !f.endsWith("channels.ts"))
      .map((f) => fs.readFileSync(path.join(root, "apps/api/src", f), "utf8")).join("\n");
    for (const name of Object.values(PLACEHOLDER_ENV).flat()) {
      expect(name).toMatch(/^PLACEHOLDER_[A-Z0-9_]+$/);
      expect(envExample, name).toMatch(new RegExp(`^# ${name}=$`, "m"));
      expect(envExample, name).not.toMatch(new RegExp(`^${name}=`, "m"));
      expect(doc, name).toContain(`\`${name}\``);
      expect(src, name).not.toContain(name);
    }
    expect(doc).toMatch(/None of these connections is wired/);
  });
});
