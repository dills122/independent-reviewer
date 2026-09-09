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

/** Compacts every guidance block into a small, stable, citeable prompt digest. */
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
    let explicitRuleNumber = 0;
    let contextNumber = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim() ?? "";
      if (/^#{1,3}\s+/.test(line)) {
        section = line.replace(/^#{1,3}\s+/, "");
        contextNumber += 1;
        const heading = {
          ruleId: `${input.id}:C${contextNumber}`,
          section,
          text: section,
        };
        const headingSize = JSON.stringify(heading).length;
        if (headingSize > remaining) {
          truncated = true;
          break;
        }
        rules.push(heading);
        remaining -= headingSize;
        continue;
      }
      if (line.length === 0) {
        continue;
      }
      const isExplicitRule = /^(?:[-*]|\d+\.)\s+/.test(line);
      const parts = [isExplicitRule ? line.replace(/^(?:[-*]|\d+\.)\s+/, "") : line];
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
      if (isExplicitRule) {
        explicitRuleNumber += 1;
      } else {
        contextNumber += 1;
      }
      const itemNumber = isExplicitRule ? explicitRuleNumber : contextNumber;
      const rule = {
        ruleId: `${input.id}:${isExplicitRule ? "R" : "C"}${itemNumber}`,
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
