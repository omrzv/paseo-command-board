import { describe, expect, it } from "vitest";
import { insightPrompt, parseInsightReply } from "../../server/insights";

describe("insights", () => {
  it("reads the JSON object, also inside a fence or prose, and trims a trailing period", () => {
    expect(parseInsightReply('{"title":"Fix login bug.","summary":"A. B."}')).toEqual({ title: "Fix login bug", summary: "A. B." });
    expect(parseInsightReply('```json\n{"title":"Add lane","summary":"One. Two."}\n```')).toEqual({ title: "Add lane", summary: "One. Two." });
    expect(parseInsightReply("Sure! {\"title\":\"X\",\"summary\":\"Y\"} done")).toEqual({ title: "X", summary: "Y" });
  });

  it("rejects replies without the two fields", () => {
    expect(parseInsightReply("no json here")).toBeNull();
    expect(parseInsightReply('{"title":"only"}')).toBeNull();
    expect(parseInsightReply('{"title":"","summary":"x"}')).toBeNull();
  });

  it("labels who said what, oldest first", () => {
    const prompt = insightPrompt([{ role: "user_message", text: "do it" }, { role: "assistant_message", text: "done" }]);
    expect(prompt.indexOf("PERSON: do it")).toBeLessThan(prompt.indexOf("AGENT: done"));
  });
});
