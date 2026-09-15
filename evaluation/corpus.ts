import * as z from "zod";

import { NonEmptyTextSchema, prefixedIdentifier } from "../src/contracts/primitives.js";
import { EVALUATION_CASES_V1 } from "./case-catalog.js";

const OpaqueCaseIdSchema = z.string().regex(/^case_\d{3}$/);
const CorpusSplitSchema = z.enum(["DEVELOPMENT", "HOLDOUT"]);
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
  obligationId: prefixedIdentifier("obligation"),
  description: NonEmptyTextSchema,
});
const PrivateArtifactSchema = z.strictObject({
  reference: NonEmptyTextSchema,
  content: NonEmptyTextSchema,
});

const CorpusCaseDefinitionV1Schema = z.strictObject({
  caseId: OpaqueCaseIdSchema,
  familyId: prefixedIdentifier("family"),
  pair: PairSchema.nullable(),
  split: CorpusSplitSchema,
  provenance: z.strictObject({
    kind: z.literal("SYNTHETIC"),
    source: NonEmptyTextSchema,
    sourceRevision: NonEmptyTextSchema,
    license: NonEmptyTextSchema,
  }),
  runtime: z.strictObject({
    identity: NonEmptyTextSchema,
    language: NonEmptyTextSchema,
    dependencies: z.array(NonEmptyTextSchema),
  }),
  obligations: z.array(ObligationSchema).min(1),
  expectedRoots: z.array(RootSchema),
  expectedUncertainties: z.array(UncertaintySchema),
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
        const members = pairMembers.get(entry.pair.pairId) ?? {
          familyIds: new Set<string>(),
          roles: [],
          splits: new Set<string>(),
        };
        members.familyIds.add(entry.familyId);
        members.roles.push(entry.pair.role);
        members.splits.add(entry.split);
        pairMembers.set(entry.pair.pairId, members);
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
  });

export type EvaluationCorpusCaseDefinitionV1 = z.output<typeof CorpusCaseDefinitionV1Schema>;
export type EvaluationCorpusDefinitionV1 = z.output<typeof EvaluationCorpusDefinitionV1Schema>;

const PAIRS = {
  case_001: ["pair_checkout", "CLEAN"],
  case_002: ["pair_checkout", "DEFECT"],
  case_003: ["pair_boundaries", "DEFECT"],
  case_004: ["pair_access", "DEFECT"],
  case_005: ["pair_boundaries", "CLEAN"],
  case_006: ["pair_naming_direct", "DEFECT"],
  case_007: ["pair_naming_direct", "CLEAN"],
  case_008: ["pair_naming_exception", "CLEAN"],
  case_009: ["pair_naming_exception", "DEFECT"],
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
  case_024: ["pair_state_lifecycle", "CLEAN"],
  case_025: ["pair_state_lifecycle", "DEFECT"],
  case_026: ["pair_default_compatibility", "CLEAN"],
  case_027: ["pair_default_compatibility", "DEFECT"],
} as const;

const HOLDOUT_FAMILIES = new Set([
  "javascript-access",
  "typescript-naming-registry",
  "go-helper-contract",
  "java-api-compatibility",
  "control-partial-labels",
]);

const ROOT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  root_002_double_currency_conversion: "Cents returned by pricing are multiplied by 100 again.",
  root_003_pagination_exclusive_end: "Inclusive arithmetic drops the last item from each page.",
  root_003_shipping_threshold_equality: "A subtotal of exactly 5000 cents loses free shipping.",
  root_004_access_predicate_inversion: "Owner equality is inverted, granting non-owner access.",
  root_006_mandatory_export_name: "Single-letter exported name violates mandatory naming rule.",
  root_009_unsupported_mandatory_defense:
    "Author preference does not satisfy or except mandatory naming rule.",
  root_016_python_exceptional_resource_cleanup:
    "Read failure bypasses close after try/finally removal.",
  root_018_go_helper_unit_contract: "Helper stops converting whole dollars into cents.",
  root_020_java_json_field_compatibility:
    "Record component rename changes existing serialized JSON field.",
  root_022_registry_name_mismatch: "Exported name contradicts required frozen registry value.",
  root_023_mandatory_export_name_after_extraction:
    "Helper extraction also introduces prohibited single-letter export.",
  root_025_completed_job_reopened: "Completed jobs are added to retryable states and reopen.",
  root_027_zero_batch_size_overwritten: "Truthy fallback replaces explicit zero with default.",
  root_029_author_cannot_replace_cache_requirement:
    "Changed TTL exceeds frozen requirement despite author assertion.",
};

const UNCERTAINTIES: Readonly<Record<string, readonly [string, string][]>> = {
  case_011: [
    ["uncertainty_011_conflicting_rules", "Conflicting mandatory rules prevent one valid status."],
  ],
  case_012: [
    ["uncertainty_012_missing_registry", "Required authoritative naming registry is absent."],
  ],
};

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

function definitionForCase(
  testCase: (typeof EVALUATION_CASES_V1)[number],
): EvaluationCorpusCaseDefinitionV1 {
  const obligationId = `obligation_${testCase.id}` as const;
  const pairTuple = PAIRS[testCase.id as keyof typeof PAIRS];
  const roots = testCase.oracle.expectedRootIds
    .filter((rootId) => ROOT_DESCRIPTIONS[rootId] !== undefined)
    .map((rootId) => ({
      rootId,
      obligationId,
      description: ROOT_DESCRIPTIONS[rootId] ?? rootId,
    }));
  const uncertainties = (UNCERTAINTIES[testCase.id] ?? []).map(([uncertaintyId, description]) => ({
    uncertaintyId,
    obligationId,
    description,
  }));
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
    split: HOLDOUT_FAMILIES.has(testCase.family) ? "HOLDOUT" : "DEVELOPMENT",
    provenance: {
      kind: "SYNTHETIC",
      source: "Repository-authored deterministic evaluation fixture.",
      sourceRevision: `corpus_v1/${testCase.id}`,
      license: "Repository-authored synthetic fixture; no third-party license applies.",
    },
    runtime: runtimeForCase(testCase.id),
    obligations: [{ obligationId, text: obligationText }],
    expectedRoots: roots,
    expectedUncertainties: uncertainties,
    labelsExhaustive: testCase.id !== "case_030",
    evaluatorOnly: {
      hiddenTest: {
        reference: hiddenReference,
        content: JSON.stringify({
          caseId: testCase.id,
          expectedVerdict: testCase.oracle.expectedVerdict,
          roots,
          uncertainties,
          assertion: "Evaluate declared obligation against reconstructed BASE and HEAD.",
        }),
      },
      fixingPatch:
        roots.length === 0
          ? null
          : {
              reference: patchReference,
              content: `Evaluator correction for ${testCase.id}:\n${roots
                .map(({ description }) => `- ${description}`)
                .join("\n")}\n`,
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
