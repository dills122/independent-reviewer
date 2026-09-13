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
  maximumBytes = 12_000,
): ProjectGuidanceDigestEntryV1[] {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("maximumBytes must be a positive safe integer.");
  }

  const bytesPerInput = Math.floor(maximumBytes / Math.max(guidance.length, 1));
  return guidance.map((input) => {
    const rules: ProjectGuidanceRuleV1[] = [];
    const lines = input.content.split("\n");
    let section = input.title;
    let truncated = false;
    let remainingBytes = bytesPerInput;
    let explicitRuleNumber = 0;
    let contextNumber = 0;
    let cursor = 0;
    const appendRule = (rule: ProjectGuidanceRuleV1): boolean => {
      const bytes = Buffer.byteLength(JSON.stringify(rule), "utf8");
      if (bytes > remainingBytes) {
        truncated = true;
        return false;
      }
      rules.push(rule);
      remainingBytes -= bytes;
      return true;
    };

    while (cursor < lines.length) {
      const line = lines[cursor]?.trim() ?? "";
      if (/^#{1,3}\s+/.test(line)) {
        section = line.replace(/^#{1,3}\s+/, "");
        contextNumber += 1;
        cursor += 1;
        if (
          !appendRule({
            ruleId: `${input.id}:C${contextNumber}`,
            section,
            text: section,
          })
        ) {
          break;
        }
        continue;
      }
      if (line.length === 0) {
        cursor += 1;
        continue;
      }
      const isExplicitRule = /^(?:[-*]|\d+\.)\s+/.test(line);
      const parts = [isExplicitRule ? line.replace(/^(?:[-*]|\d+\.)\s+/, "") : line];
      cursor += 1;
      while (cursor < lines.length) {
        const continuation = lines[cursor]?.trim() ?? "";
        if (
          continuation.length === 0 ||
          /^#{1,3}\s+/.test(continuation) ||
          /^(?:[-*]|\d+\.)\s+/.test(continuation)
        ) {
          break;
        }
        parts.push(continuation);
        cursor += 1;
      }
      if (isExplicitRule) {
        explicitRuleNumber += 1;
      } else {
        contextNumber += 1;
      }
      const itemNumber = isExplicitRule ? explicitRuleNumber : contextNumber;
      if (
        !appendRule({
          ruleId: `${input.id}:${isExplicitRule ? "R" : "C"}${itemNumber}`,
          section,
          text: parts.join(" "),
        })
      ) {
        break;
      }
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
