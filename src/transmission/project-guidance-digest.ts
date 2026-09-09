import type { NeutralReviewBriefV1 } from "../contracts/index.js";

export interface ProjectGuidanceRuleV1 {
  readonly ruleId: string;
  readonly section: string;
  readonly text: string;
}

export interface ProjectGuidanceDigestEntryV1 {
  readonly id: string;
  readonly title: string;
  readonly provenance: NeutralReviewBriefV1["canonicalInputs"]["projectGuidance"][number]["provenance"];
  readonly rules: ProjectGuidanceRuleV1[];
  readonly truncated: boolean;
}

/** Extracts explicit Markdown list rules into a small, stable, citeable prompt digest. */
export function compactProjectGuidanceV1(
  guidance: NeutralReviewBriefV1["canonicalInputs"]["projectGuidance"],
  maximumCharacters = 12_000,
): ProjectGuidanceDigestEntryV1[] {
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 1) {
    throw new TypeError("maximumCharacters must be a positive safe integer.");
  }

  let remaining = maximumCharacters;
  return guidance.map((input) => {
    const rules: ProjectGuidanceRuleV1[] = [];
    const lines = input.content.split("\n");
    let section = input.title;
    let truncated = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim() ?? "";
      if (/^#{1,3}\s+/.test(line)) {
        section = line.replace(/^#{1,3}\s+/, "");
        continue;
      }
      if (!/^(?:[-*]|\d+\.)\s+/.test(line)) {
        continue;
      }
      const parts = [line.replace(/^(?:[-*]|\d+\.)\s+/, "")];
      while (index + 1 < lines.length) {
        const continuation = lines[index + 1]?.trim() ?? "";
        if (
          continuation.length === 0 ||
          /^#{1,3}\s+/.test(continuation) ||
          /^(?:[-*]|\d+\.)\s+/.test(continuation)
        ) {
          break;
        }
        parts.push(continuation);
        index += 1;
      }
      const rule = {
        ruleId: `${input.id}:R${rules.length + 1}`,
        section,
        text: parts.join(" "),
      };
      const size = JSON.stringify(rule).length;
      if (size > remaining) {
        truncated = true;
        break;
      }
      rules.push(rule);
      remaining -= size;
    }
    return {
      id: input.id,
      title: input.title,
      provenance: input.provenance,
      rules,
      truncated,
    };
  });
}
