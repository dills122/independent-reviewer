import * as z from "zod";

import { NonEmptyTextSchema, prefixedIdentifier } from "../src/contracts/primitives.js";
import { EVALUATION_CASES_V1 } from "./case-catalog.js";

const OpaqueCaseIdSchema = z.string().regex(/^case_\d{3}$/);
const CorpusSplitSchema = z.enum(["DEVELOPMENT", "HOLDOUT"]);
const ControlRoleSchema = z.enum([
  "MISSING_REQUIRED_CONTEXT",
  "IRRELEVANT_MISSING_CONTEXT",
  "MISLEADING_AUTHOR_CONCERN",
  "UNSUPPORTED_AUTHOR_DEFENSE",
  "CONFLICTING_APPLICABLE_STANDARDS",
  "POST_AUTHOR_CLAIM_CHANGE",
]);
const PairSchema = z.strictObject({
  pairId: prefixedIdentifier("pair"),
  role: z.enum(["DEFECT", "CLEAN"]),
});
const ObligationSchema = z.strictObject({
  obligationId: prefixedIdentifier("obligation"),
  text: NonEmptyTextSchema,
});
const RootSchema = z.strictObject({
  rootId: prefixedIdentifier("root"),
  obligationId: prefixedIdentifier("obligation"),
  description: NonEmptyTextSchema,
});
const UncertaintySchema = z.strictObject({
  uncertaintyId: prefixedIdentifier("uncertainty"),
  sourceOracleId: prefixedIdentifier("root"),
  obligationId: prefixedIdentifier("obligation"),
  description: NonEmptyTextSchema,
});
const RecommendationSchema = z.strictObject({
  recommendationId: z.string().regex(/^recommendation_[A-Za-z0-9][A-Za-z0-9_-]*$/),
  sourceOracleId: prefixedIdentifier("root"),
  obligationId: prefixedIdentifier("obligation"),
  description: NonEmptyTextSchema,
});
const PrivateArtifactSchema = z.strictObject({
  reference: NonEmptyTextSchema,
  content: NonEmptyTextSchema,
});
const SyntheticProvenanceSchema = z.strictObject({
  kind: z.literal("SYNTHETIC"),
  source: NonEmptyTextSchema,
  sourceRepository: NonEmptyTextSchema,
  sourceRevision: NonEmptyTextSchema,
  sourcePath: z.null(),
  issueReferences: z.array(NonEmptyTextSchema).length(0),
  fixReferences: z.array(NonEmptyTextSchema).length(0),
  licenseStatus: z.literal("REPOSITORY_AUTHORED"),
  license: NonEmptyTextSchema,
  environmentRequirements: z.array(NonEmptyTextSchema).min(1),
});
const ReverseFixProvenanceSchema = z.strictObject({
  kind: z.literal("REPOSITORY_REVERSE_FIX"),
  source: NonEmptyTextSchema,
  sourceRepository: NonEmptyTextSchema,
  sourceRevision: z.string().regex(/^[0-9a-f]{40}$/),
  sourceParentRevision: z.string().regex(/^[0-9a-f]{40}$/),
  sourcePath: NonEmptyTextSchema,
  sourceBlobGitObject: z.string().regex(/^[0-9a-f]{40}$/),
  issueReferences: z.array(NonEmptyTextSchema).min(1),
  fixReferences: z.array(NonEmptyTextSchema).min(1),
  licenseStatus: z.literal("NO_LICENSE_FILE"),
  license: NonEmptyTextSchema,
  environmentRequirements: z.array(NonEmptyTextSchema).min(1),
  derivation: z.literal("REDUCED_REVERSE_FIX"),
});

const CorpusCaseDefinitionV1Schema = z.strictObject({
  caseId: OpaqueCaseIdSchema,
  familyId: prefixedIdentifier("family"),
  pair: PairSchema.nullable(),
  controlRole: ControlRoleSchema.nullable(),
  split: CorpusSplitSchema,
  provenance: z.discriminatedUnion("kind", [SyntheticProvenanceSchema, ReverseFixProvenanceSchema]),
  runtime: z.strictObject({
    identity: NonEmptyTextSchema,
    language: NonEmptyTextSchema,
    dependencies: z.array(NonEmptyTextSchema),
  }),
  obligations: z.array(ObligationSchema).min(1),
  expectedRoots: z.array(RootSchema),
  expectedUncertainties: z.array(UncertaintySchema),
  expectedRecommendations: z.array(RecommendationSchema),
  labelsExhaustive: z.boolean(),
  evaluatorOnly: z.strictObject({
    hiddenTest: PrivateArtifactSchema,
    fixingPatch: PrivateArtifactSchema.nullable(),
  }),
});

const EvaluationCorpusDefinitionV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    corpusVersion: NonEmptyTextSchema,
    splitVersion: NonEmptyTextSchema,
    cases: z.array(CorpusCaseDefinitionV1Schema).min(1),
  })
  .superRefine((corpus, context) => {
    const catalogIds = new Set<string>(EVALUATION_CASES_V1.map(({ id }) => id));
    const seenCaseIds = new Set<string>();
    const familySplits = new Map<string, string>();
    const pairMembers = new Map<
      string,
      { familyIds: Set<string>; roles: string[]; splits: Set<string> }
    >();
    const controlRoleCounts = new Map<string, number>();

    for (const [index, entry] of corpus.cases.entries()) {
      if (seenCaseIds.has(entry.caseId)) {
        context.addIssue({ code: "custom", message: "duplicate case ID", path: ["cases", index] });
      }
      seenCaseIds.add(entry.caseId);
      if (!catalogIds.has(entry.caseId)) {
        context.addIssue({
          code: "custom",
          message: "case definition has no reconstructable catalog case",
          path: ["cases", index, "caseId"],
        });
      }

      const familySplit = familySplits.get(entry.familyId);
      if (familySplit !== undefined && familySplit !== entry.split) {
        context.addIssue({
          code: "custom",
          message: "one repository family cannot cross corpus splits",
          path: ["cases", index, "split"],
        });
      }
      familySplits.set(entry.familyId, entry.split);

      const obligationIds = new Set(entry.obligations.map(({ obligationId }) => obligationId));
      for (const root of entry.expectedRoots) {
        if (!obligationIds.has(root.obligationId)) {
          context.addIssue({
            code: "custom",
            message: "root references unknown obligation",
            path: ["cases", index, "expectedRoots"],
          });
        }
      }
      for (const uncertainty of entry.expectedUncertainties) {
        if (!obligationIds.has(uncertainty.obligationId)) {
          context.addIssue({
            code: "custom",
            message: "uncertainty references unknown obligation",
            path: ["cases", index, "expectedUncertainties"],
          });
        }
      }
      for (const recommendation of entry.expectedRecommendations) {
        if (!obligationIds.has(recommendation.obligationId)) {
          context.addIssue({
            code: "custom",
            message: "recommendation references unknown obligation",
            path: ["cases", index, "expectedRecommendations"],
          });
        }
      }
      if (entry.expectedRoots.length > 0 && entry.evaluatorOnly.fixingPatch === null) {
        context.addIssue({
          code: "custom",
          message: "known roots require an evaluator-only fixing patch",
          path: ["cases", index, "evaluatorOnly", "fixingPatch"],
        });
      }
      if (entry.pair?.role === "DEFECT" && entry.expectedRoots.length === 0) {
        context.addIssue({
          code: "custom",
          message: "DEFECT pair member requires a known root",
          path: ["cases", index, "expectedRoots"],
        });
      }
      if (entry.pair?.role === "CLEAN" && entry.expectedRoots.length > 0) {
        context.addIssue({
          code: "custom",
          message: "CLEAN pair member cannot declare a known root",
          path: ["cases", index, "expectedRoots"],
        });
      }
      if (/bug|defect|clean/i.test(entry.evaluatorOnly.hiddenTest.reference)) {
        context.addIssue({
          code: "custom",
          message: "oracle reference reveals a corpus label",
          path: ["cases", index, "evaluatorOnly", "hiddenTest", "reference"],
        });
      }

      if (entry.pair !== null) {
        if (entry.controlRole !== null) {
          context.addIssue({
            code: "custom",
            message: "paired case cannot declare a control role",
            path: ["cases", index, "controlRole"],
          });
        }
        const members = pairMembers.get(entry.pair.pairId) ?? {
          familyIds: new Set<string>(),
          roles: [],
          splits: new Set<string>(),
        };
        members.familyIds.add(entry.familyId);
        members.roles.push(entry.pair.role);
        members.splits.add(entry.split);
        pairMembers.set(entry.pair.pairId, members);
      } else if (entry.controlRole === null) {
        context.addIssue({
          code: "custom",
          message: "unpaired case must declare one canonical control role",
          path: ["cases", index, "controlRole"],
        });
      } else {
        controlRoleCounts.set(
          entry.controlRole,
          (controlRoleCounts.get(entry.controlRole) ?? 0) + 1,
        );
      }
    }

    if (seenCaseIds.size !== catalogIds.size) {
      context.addIssue({
        code: "custom",
        message: "corpus definition must cover every reconstructable catalog case",
        path: ["cases"],
      });
    }
    for (const [pairId, members] of pairMembers) {
      if (
        members.roles.length !== 2 ||
        members.roles.filter((role) => role === "DEFECT").length !== 1 ||
        members.roles.filter((role) => role === "CLEAN").length !== 1 ||
        members.familyIds.size !== 1 ||
        members.splits.size !== 1
      ) {
        context.addIssue({
          code: "custom",
          message: `${pairId} must contain one same-family, same-split DEFECT/CLEAN pair`,
          path: ["cases"],
        });
      }
    }
    for (const role of ControlRoleSchema.options) {
      if (controlRoleCounts.get(role) !== 1) {
        context.addIssue({
          code: "custom",
          message: `control role ${role} must occur exactly once`,
          path: ["cases"],
        });
      }
    }
  });

export type EvaluationCorpusCaseDefinitionV1 = z.output<typeof CorpusCaseDefinitionV1Schema>;
export type EvaluationCorpusDefinitionV1 = z.output<typeof EvaluationCorpusDefinitionV1Schema>;

const PAIRS = {
  case_001: ["pair_git_nul_fields", "CLEAN"],
  case_002: ["pair_git_nul_fields", "DEFECT"],
  case_003: ["pair_boundaries", "DEFECT"],
  case_004: ["pair_access", "DEFECT"],
  case_006: ["pair_naming_direct", "DEFECT"],
  case_007: ["pair_naming_direct", "CLEAN"],
  case_008: ["pair_naming_exception", "CLEAN"],
  case_010: ["pair_naming_exception", "DEFECT"],
  case_013: ["pair_naming_extraction", "CLEAN"],
  case_014: ["pair_naming_registry", "CLEAN"],
  case_015: ["pair_python_resource", "CLEAN"],
  case_016: ["pair_python_resource", "DEFECT"],
  case_017: ["pair_go_units", "CLEAN"],
  case_018: ["pair_go_units", "DEFECT"],
  case_019: ["pair_java_api", "CLEAN"],
  case_020: ["pair_java_api", "DEFECT"],
  case_021: ["pair_access", "CLEAN"],
  case_022: ["pair_naming_registry", "DEFECT"],
  case_023: ["pair_naming_extraction", "DEFECT"],
  case_024: ["pair_markdown_structure", "CLEAN"],
  case_025: ["pair_markdown_structure", "DEFECT"],
  case_026: ["pair_grammar_provenance", "CLEAN"],
  case_027: ["pair_grammar_provenance", "DEFECT"],
  case_030: ["pair_boundaries", "CLEAN"],
} as const;

const CONTROL_ROLES = {
  case_005: "MISLEADING_AUTHOR_CONCERN",
  case_009: "UNSUPPORTED_AUTHOR_DEFENSE",
  case_011: "CONFLICTING_APPLICABLE_STANDARDS",
  case_012: "MISSING_REQUIRED_CONTEXT",
  case_028: "IRRELEVANT_MISSING_CONTEXT",
  case_029: "POST_AUTHOR_CLAIM_CHANGE",
} as const;

const HOLDOUT_FAMILIES = new Set([
  "javascript-access",
  "typescript-naming-registry",
  "go-helper-contract",
  "java-api-compatibility",
  "control-irrelevant-context",
]);

type OracleClassification =
  | { kind: "ROOT"; description: string }
  | { kind: "UNCERTAINTY"; uncertaintyId: `uncertainty_${string}`; description: string }
  | {
      kind: "RECOMMENDATION";
      recommendationId: `recommendation_${string}`;
      description: string;
    };

const ORACLE_CLASSIFICATIONS: Readonly<Record<string, OracleClassification>> = {
  root_002_git_nul_path_trimmed: {
    kind: "ROOT",
    description: "Text trimming removes leading whitespace from first NUL-delimited Git path.",
  },
  root_003_pagination_exclusive_end: {
    kind: "ROOT",
    description: "Inclusive arithmetic drops the last item from each page.",
  },
  root_003_shipping_threshold_equality: {
    kind: "ROOT",
    description: "A subtotal of exactly 5000 cents loses free shipping.",
  },
  root_004_access_predicate_inversion: {
    kind: "ROOT",
    description: "Owner equality is inverted, granting non-owner access.",
  },
  root_006_mandatory_export_name: {
    kind: "ROOT",
    description: "Single-letter exported name violates mandatory naming rule.",
  },
  root_009_unsupported_mandatory_defense: {
    kind: "ROOT",
    description: "Author preference does not satisfy or except mandatory naming rule.",
  },
  root_010_advisory_export_name: {
    kind: "RECOMMENDATION",
    recommendationId: "recommendation_010_advisory_export_name",
    description: "A descriptive full-word export remains useful non-blocking advice.",
  },
  root_010_required_exception_annotation: {
    kind: "ROOT",
    description: "Short exported name lacks annotation required by mandatory exception.",
  },
  root_011_conflicting_mandatory_rules: {
    kind: "UNCERTAINTY",
    uncertaintyId: "uncertainty_011_conflicting_rules",
    description: "Conflicting mandatory rules prevent one valid status.",
  },
  root_012_required_reference_absent: {
    kind: "UNCERTAINTY",
    uncertaintyId: "uncertainty_012_missing_registry",
    description: "Required authoritative naming registry is absent.",
  },
  root_016_python_exceptional_resource_cleanup: {
    kind: "ROOT",
    description: "Read failure bypasses close after try/finally removal.",
  },
  root_018_go_helper_unit_contract: {
    kind: "ROOT",
    description: "Helper stops converting whole dollars into cents.",
  },
  root_020_java_json_field_compatibility: {
    kind: "ROOT",
    description: "Record component rename changes existing serialized JSON field.",
  },
  root_022_registry_name_mismatch: {
    kind: "ROOT",
    description: "Exported name contradicts required frozen registry value.",
  },
  root_023_mandatory_export_name_after_extraction: {
    kind: "ROOT",
    description: "Helper extraction also introduces prohibited single-letter export.",
  },
  root_025_markdown_structure_escape: {
    kind: "ROOT",
    description: "Line breaks and block punctuation let untrusted prose restructure Markdown.",
  },
  root_027_stale_grammar_version: {
    kind: "ROOT",
    description: "Hard-coded grammar version can disagree with resolved package manifest.",
  },
  root_029_author_cannot_replace_cache_requirement: {
    kind: "ROOT",
    description: "Changed TTL exceeds frozen requirement despite author assertion.",
  },
};

function classifiedOracle(
  sourceOracleId: string,
  expectedKind: OracleClassification["kind"],
): OracleClassification {
  const classification = ORACLE_CLASSIFICATIONS[sourceOracleId];
  if (!classification) throw new Error(`Unknown catalog oracle ID ${sourceOracleId}.`);
  if (classification.kind !== expectedKind) {
    throw new Error(
      `Catalog oracle ID ${sourceOracleId} is ${classification.kind}, not ${expectedKind}.`,
    );
  }
  return classification;
}

export function classifyEvaluationCaseOracleV1(
  testCase: (typeof EVALUATION_CASES_V1)[number],
  obligationId: `obligation_${string}`,
) {
  const roots = testCase.oracle.expectedRootIds.map((rootId) => {
    const classification = classifiedOracle(rootId, "ROOT");
    if (classification.kind !== "ROOT") throw new Error("Unreachable oracle classification.");
    return { rootId, obligationId, description: classification.description };
  });
  const uncertainties = testCase.oracle.expectedUncertaintyIds.map((sourceOracleId) => {
    const classification = classifiedOracle(sourceOracleId, "UNCERTAINTY");
    if (classification.kind !== "UNCERTAINTY") {
      throw new Error("Unreachable oracle classification.");
    }
    return {
      uncertaintyId: classification.uncertaintyId,
      sourceOracleId,
      obligationId,
      description: classification.description,
    };
  });
  const recommendations = testCase.oracle.expectedRecommendationIds.map((sourceOracleId) => {
    const classification = classifiedOracle(sourceOracleId, "RECOMMENDATION");
    if (classification.kind !== "RECOMMENDATION") {
      throw new Error("Unreachable oracle classification.");
    }
    return {
      recommendationId: classification.recommendationId,
      sourceOracleId,
      obligationId,
      description: classification.description,
    };
  });
  return { roots, uncertainties, recommendations };
}

function familyId(family: string): `family_${string}` {
  return `family_${family.replaceAll("-", "_")}`;
}

function runtimeForCase(caseId: string): {
  identity: string;
  language: string;
  dependencies: string[];
} {
  const testCase = EVALUATION_CASES_V1.find(({ id }) => id === caseId);
  const extensions = new Set(
    testCase?.repository.files.map(({ path }) => path.slice(path.lastIndexOf("."))) ?? [],
  );
  if (extensions.has(".py")) {
    return { identity: "python; executor=UNQUALIFIED", language: "Python", dependencies: [] };
  }
  if (extensions.has(".go")) {
    return { identity: "go; executor=UNQUALIFIED", language: "Go", dependencies: [] };
  }
  if (extensions.has(".java")) {
    return { identity: "java; executor=UNQUALIFIED", language: "Java", dependencies: [] };
  }
  if (extensions.has(".ts")) {
    return {
      identity: "typescript; executor=UNQUALIFIED",
      language: "TypeScript",
      dependencies: [],
    };
  }
  return {
    identity: "ecmascript-module; executor=UNQUALIFIED",
    language: "JavaScript",
    dependencies: [],
  };
}

function patchLines(content: string): string[] {
  const withoutFinalNewline = content.endsWith("\n") ? content.slice(0, -1) : content;
  return withoutFinalNewline.length === 0 ? [] : withoutFinalNewline.split("\n");
}

function goldFixForCase(testCase: (typeof EVALUATION_CASES_V1)[number]): string {
  return testCase.repository.files
    .filter(({ base, head }) => base !== head)
    .map((file) => {
      const before = patchLines(file.head ?? "");
      const after = patchLines(file.base ?? "");
      return [
        `--- ${file.head === undefined ? "/dev/null" : `a/${file.path}`}`,
        `+++ ${file.base === undefined ? "/dev/null" : `b/${file.path}`}`,
        `@@ -${before.length === 0 ? 0 : 1},${before.length} +${after.length === 0 ? 0 : 1},${after.length} @@`,
        ...before.map((line) => `-${line}`),
        ...after.map((line) => `+${line}`),
      ].join("\n");
    })
    .join("\n");
}

const REVERSE_FIX_SOURCE = {
  case_001: {
    issue: "128",
    path: "src/snapshot/git-capture.ts",
    blob: "7c049cf0c45e635691cf5ddbb13ca5833a4bb57c",
    environment:
      "Git NUL-delimited path output and Node.js 24 Uint8Array decoding; no external service.",
  },
  case_002: {
    issue: "128",
    path: "src/snapshot/git-capture.ts",
    blob: "7c049cf0c45e635691cf5ddbb13ca5833a4bb57c",
    environment:
      "Git NUL-delimited path output and Node.js 24 Uint8Array decoding; no external service.",
  },
  case_024: {
    issue: "132",
    path: "src/report/markdown.ts",
    blob: "85e258d98c54237d472be52288ccf5d60c319124",
    environment: "CommonMark-compatible Markdown rendering of untrusted UTF-8 prose.",
  },
  case_025: {
    issue: "132",
    path: "src/report/markdown.ts",
    blob: "85e258d98c54237d472be52288ccf5d60c319124",
    environment: "CommonMark-compatible Markdown rendering of untrusted UTF-8 prose.",
  },
  case_026: {
    issue: "137",
    path: "src/context/tree-sitter-analyzer.ts",
    blob: "99c81ffbfe104863611f7418252eb59929b0081d",
    environment:
      "Node.js 24 package resolution with tree-sitter-javascript manifest version 0.25.0.",
  },
  case_027: {
    issue: "137",
    path: "src/context/tree-sitter-analyzer.ts",
    blob: "99c81ffbfe104863611f7418252eb59929b0081d",
    environment:
      "Node.js 24 package resolution with tree-sitter-javascript manifest version 0.25.0.",
  },
} as const;

function provenanceForCase(
  testCase: (typeof EVALUATION_CASES_V1)[number],
): EvaluationCorpusCaseDefinitionV1["provenance"] {
  const historical = REVERSE_FIX_SOURCE[testCase.id as keyof typeof REVERSE_FIX_SOURCE];
  if (historical) {
    return {
      kind: "REPOSITORY_REVERSE_FIX",
      source: `Reduced reverse-fix fixture derived from repository regression #${historical.issue}.`,
      sourceRepository: "https://github.com/dills122/independent-reviewer",
      sourceRevision: "597e2ba758a232f109f85dc01c47e21f9d30ed2a",
      sourceParentRevision: "759346fed286978c3d2f59cb59e6fe0b3e9151b4",
      sourcePath: historical.path,
      sourceBlobGitObject: historical.blob,
      issueReferences: [
        `https://github.com/dills122/independent-reviewer/issues/${historical.issue}`,
      ],
      fixReferences: [
        "https://github.com/dills122/independent-reviewer/commit/597e2ba758a232f109f85dc01c47e21f9d30ed2a",
        "https://github.com/dills122/independent-reviewer/pull/139",
      ],
      licenseStatus: "NO_LICENSE_FILE",
      license:
        "No top-level license file exists at source revision; repository-owner-authored code is retained only for this repository's evaluator.",
      environmentRequirements: [historical.environment],
      derivation: "REDUCED_REVERSE_FIX",
    };
  }
  return {
    kind: "SYNTHETIC",
    source: "Repository-authored deterministic evaluation fixture.",
    sourceRepository: "https://github.com/dills122/independent-reviewer",
    sourceRevision: `corpus_v1/${testCase.id}`,
    sourcePath: null,
    issueReferences: [],
    fixReferences: [],
    licenseStatus: "REPOSITORY_AUTHORED",
    license: "Repository-authored synthetic fixture; no third-party license applies.",
    environmentRequirements: ["Clean Git checkout; case runtime remains unqualified."],
  };
}

function definitionForCase(
  testCase: (typeof EVALUATION_CASES_V1)[number],
): EvaluationCorpusCaseDefinitionV1 {
  const obligationId = `obligation_${testCase.id}` as const;
  const pairTuple = PAIRS[testCase.id as keyof typeof PAIRS];
  const controlRole = CONTROL_ROLES[testCase.id as keyof typeof CONTROL_ROLES] ?? null;
  const { roots, uncertainties, recommendations } = classifyEvaluationCaseOracleV1(
    testCase,
    obligationId,
  );
  const hiddenReference = `oracles/v1/${testCase.id}/assertion.json`;
  const patchReference = `oracles/v1/${testCase.id}/correction.patch`;
  const obligationText =
    testCase.reviewer.kind === "requirements"
      ? testCase.reviewer.requirements
      : `Apply selected standards profile: ${JSON.stringify(testCase.reviewer.profile)}`;

  return {
    caseId: testCase.id,
    familyId: familyId(testCase.family),
    pair: pairTuple ? { pairId: pairTuple[0], role: pairTuple[1] } : null,
    controlRole,
    split: HOLDOUT_FAMILIES.has(testCase.family) ? "HOLDOUT" : "DEVELOPMENT",
    provenance: provenanceForCase(testCase),
    runtime: runtimeForCase(testCase.id),
    obligations: [{ obligationId, text: obligationText }],
    expectedRoots: roots,
    expectedUncertainties: uncertainties,
    expectedRecommendations: recommendations,
    labelsExhaustive: testCase.oracle.labelsExhaustive,
    evaluatorOnly: {
      hiddenTest: {
        reference: hiddenReference,
        content: JSON.stringify({
          caseId: testCase.id,
          expectedVerdict: testCase.oracle.expectedVerdict,
          roots,
          uncertainties,
          recommendations,
          assertion: "Evaluate declared obligation against reconstructed BASE and HEAD.",
        }),
      },
      fixingPatch:
        roots.length === 0
          ? null
          : {
              reference: patchReference,
              content: goldFixForCase(testCase),
            },
    },
  };
}

export const EVALUATION_CORPUS_V1 = {
  schemaVersion: 1,
  corpusVersion: "corpus_v1",
  splitVersion: "split_v1",
  cases: EVALUATION_CASES_V1.map(definitionForCase),
} as const;

export function validateEvaluationCorpusDefinitionV1(value: unknown): EvaluationCorpusDefinitionV1 {
  return EvaluationCorpusDefinitionV1Schema.parse(value);
}
