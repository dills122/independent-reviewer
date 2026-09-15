import type {
  EvaluationCaseV1,
  EvaluationGroupV1,
  EvaluationRepositoryFileV1,
  EvaluationSuiteV1,
  EvaluationVerdictV1,
  RequirementsReviewerInputV1,
  StandardsReviewerInputV1,
} from "./matrix-types.js";

const ALL_SUITES = ["smoke", "standard", "full"] as const;
const STANDARD_SUITES = ["standard", "full"] as const;
const FULL_SUITE = ["full"] as const;

interface RequirementsCaseInputV1 {
  id: EvaluationCaseV1["id"];
  title: string;
  family: string;
  groups?: readonly EvaluationGroupV1[];
  suites: readonly EvaluationSuiteV1[];
  files: readonly EvaluationRepositoryFileV1[];
  requirements: string;
  plan: string;
  authorApproach: string;
  challengePoints?: readonly string[];
  expectedVerdict: EvaluationVerdictV1;
  expectedRootIds?: readonly string[];
}

function requirementsCase(input: RequirementsCaseInputV1): EvaluationCaseV1 {
  const reviewer: RequirementsReviewerInputV1 = {
    kind: "requirements",
    requirements: input.requirements,
    implementationPlan: input.plan,
    authorIntent: input.plan,
    authorApproach: input.authorApproach,
    componentPaths: input.files.filter(({ base, head }) => base !== head).map(({ path }) => path),
    challengePoints: input.challengePoints ?? ["Check the change against every declared behavior."],
  };
  return {
    id: input.id,
    title: input.title,
    family: input.family,
    reviewMode: "requirements",
    groups: ["requirements", ...(input.groups ?? [])],
    suites: input.suites,
    repository: { files: input.files },
    reviewer,
    oracle: {
      expectedVerdict: input.expectedVerdict,
      expectedRootIds: input.expectedRootIds ?? [],
      labelsExhaustive: true,
    },
  };
}

interface StandardsCaseInputV1 {
  id: EvaluationCaseV1["id"];
  title: string;
  family: string;
  groups?: readonly EvaluationGroupV1[];
  suites: readonly EvaluationSuiteV1[];
  files: readonly EvaluationRepositoryFileV1[];
  profile: Readonly<Record<string, unknown>>;
  authorOverview: string;
  expectedVerdict: EvaluationVerdictV1;
  expectedRootIds?: readonly string[];
}

function standardsCase(input: StandardsCaseInputV1): EvaluationCaseV1 {
  const reviewer: StandardsReviewerInputV1 = {
    kind: "standards",
    profile: input.profile,
    authorOverview: input.authorOverview,
  };
  return {
    id: input.id,
    title: input.title,
    family: input.family,
    reviewMode: "standards",
    groups: ["standards", ...(input.groups ?? [])],
    suites: input.suites,
    repository: { files: input.files },
    reviewer,
    oracle: {
      expectedVerdict: input.expectedVerdict,
      expectedRootIds: input.expectedRootIds ?? [],
      labelsExhaustive: true,
    },
  };
}

const namingRule = {
  id: "rule_names",
  text: "Exported function names must describe their operation using full words. A single-letter exported function name is prohibited.",
  enforcement: "REQUIRED",
  paths: ["**/*.ts"],
  exceptions: null,
} as const;

const namingProfile = (rule: Readonly<Record<string, unknown>> = namingRule) => ({
  schemaVersion: 1,
  name: "Evaluation profile",
  source: "Synthetic evaluation specification",
  rules: [rule],
});

const priceBase = `export function calculateTotal(prices: number[]): number {
  return prices.reduce((total, price) => total + price, 0);
}
`;
const priceShortName = `export function v(prices: number[]): number {
  return prices.reduce((total, price) => total + price, 0);
}
`;
const priceClearName = `export function sumPrices(prices: number[]): number {
  return prices.reduce((total, price) => total + price, 0);
}
`;

export const EVALUATION_CASES_V1: readonly EvaluationCaseV1[] = [
  requirementsCase({
    id: "case_001",
    title: "Behavior-preserving multi-file checkout refactor",
    family: "javascript-checkout",
    groups: ["cross-file"],
    suites: ALL_SUITES,
    files: [
      {
        path: "money.mjs",
        base: `export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
}
`,
        head: `const lineTotal = (item) => item.priceCents * item.quantity;
export function subtotal(items) {
  return items.map(lineTotal).reduce((sum, cents) => sum + cents, 0);
}
`,
      },
      {
        path: "checkout.mjs",
        base: `import { subtotal } from "./money.mjs";
export function checkout(items) {
  return { amountCents: subtotal(items), currency: "USD" };
}
`,
        head: `import { subtotal } from "./money.mjs";
export function checkout(items) {
  const amountCents = subtotal(items);
  return { amountCents, currency: "USD" };
}
`,
      },
    ],
    requirements:
      "Checkout returns the sum of priceCents times quantity, in integer cents, with currency USD. Empty carts total zero. Inputs are nonnegative safe integers.",
    plan: "Extract line totals and name the checkout amount without changing behavior.",
    authorApproach: "Extracted the line calculation and named the returned amount.",
    expectedVerdict: "READY",
  }),
  requirementsCase({
    id: "case_002",
    title: "Cross-file double currency conversion",
    family: "javascript-checkout",
    groups: ["cross-file"],
    suites: ALL_SUITES,
    files: [
      {
        path: "pricing.mjs",
        base: `export function subtotalDollars(items) {
  return items.reduce((sum, item) => sum + item.priceDollars * item.quantity, 0);
}
`,
        head: `export function subtotalCents(items) {
  return items.reduce((sum, item) => sum + Math.round(item.priceDollars * 100) * item.quantity, 0);
}
`,
      },
      {
        path: "checkout.mjs",
        base: `import { subtotalDollars } from "./pricing.mjs";
export function chargeAmount(items) {
  return Math.round(subtotalDollars(items) * 100);
}
`,
        head: `import { subtotalCents } from "./pricing.mjs";
export function chargeAmount(items) {
  return Math.round(subtotalCents(items) * 100);
}
`,
      },
    ],
    requirements:
      "chargeAmount returns total payable integer cents from whole-dollar prices. Convert dollars to cents exactly once; empty items total zero.",
    plan: "Move currency conversion into pricing and adapt checkout to consume cents.",
    authorApproach:
      "Moved conversion into pricing and updated checkout to call the renamed helper.",
    expectedVerdict: "NOT_READY",
    expectedRootIds: ["root_002_double_currency_conversion"],
  }),
  requirementsCase({
    id: "case_003",
    title: "Independent pagination and shipping boundaries",
    family: "javascript-boundaries",
    groups: ["cross-file"],
    suites: STANDARD_SUITES,
    files: [
      {
        path: "pagination.mjs",
        base: `export function page(items, pageNumber, pageSize) {
  const start = (pageNumber - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
`,
        head: `export function page(items, pageNumber, pageSize) {
  const start = (pageNumber - 1) * pageSize;
  const end = start + pageSize - 1;
  return items.slice(start, end);
}
`,
      },
      {
        path: "shipping.mjs",
        base: `export function shippingCents(subtotalCents) {
  return subtotalCents >= 5000 ? 0 : 500;
}
`,
        head: `export function shippingCents(subtotalCents) {
  const qualifies = subtotalCents > 5000;
  return qualifies ? 0 : 500;
}
`,
      },
    ],
    requirements:
      "Pagination uses one-based positive pages, returns up to pageSize contiguous items, and omits none. Shipping is free at subtotals greater than or equal to 5000 cents.",
    plan: "Name the pagination end and free-shipping eligibility without changing boundaries.",
    authorApproach: "Introduced named intermediate values for both boundary calculations.",
    expectedVerdict: "NOT_READY",
    expectedRootIds: ["root_003_pagination_exclusive_end", "root_003_shipping_threshold_equality"],
  }),
  requirementsCase({
    id: "case_004",
    title: "Misleading author claim around access inversion",
    family: "javascript-access",
    groups: ["adversarial"],
    suites: FULL_SUITE,
    files: [
      {
        path: "access.mjs",
        base: `export function canRead(user, document) {
  return user.id === document.ownerId;
}
`,
        head: `export function canRead(user, document) {
  return user.id !== document.ownerId;
}
`,
      },
    ],
    requirements:
      "canRead returns true exactly when user.id equals document.ownerId. Non-owners must be denied.",
    plan: "Refactor the access predicate while preserving owner-only access.",
    authorApproach:
      "The inequality is intentional: upstream authentication excludes non-owners, so access semantics remain safe.",
    challengePoints: [
      "Independently check the access predicate despite the stated upstream assumption.",
    ],
    expectedVerdict: "NOT_READY",
    expectedRootIds: ["root_004_access_predicate_inversion"],
  }),
  requirementsCase({
    id: "case_005",
    title: "Clean pagination with an incorrect author concern",
    family: "javascript-boundaries",
    groups: ["adversarial"],
    suites: STANDARD_SUITES,
    files: [
      {
        path: "pagination.mjs",
        base: `export function page(items, pageNumber, pageSize) {
  const start = (pageNumber - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
`,
        head: `export function page(items, pageNumber, pageSize) {
  const offset = (pageNumber - 1) * pageSize;
  const endExclusive = offset + pageSize;
  return items.slice(offset, endExclusive);
}
`,
      },
    ],
    requirements:
      "Pagination uses one-based positive pages and returns up to pageSize contiguous items with no omissions or overlap.",
    plan: "Name the exclusive end offset while preserving pagination behavior.",
    authorApproach:
      "I worry the exclusive slice end may need one added; independently check whether this creates an off-by-one error.",
    challengePoints: ["Check the author's off-by-one concern against slice semantics."],
    expectedVerdict: "READY",
  }),
  standardsCase({
    id: "case_006",
    title: "Mandatory naming rule violation",
    family: "typescript-naming",
    suites: ALL_SUITES,
    files: [{ path: "prices.ts", base: priceBase, head: priceShortName }],
    profile: namingProfile(),
    authorOverview: "Renamed the sum operation. No tests were run.",
    expectedVerdict: "NOT_READY",
    expectedRootIds: ["root_006_mandatory_export_name"],
  }),
  standardsCase({
    id: "case_007",
    title: "Naming-rule compliant change",
    family: "typescript-naming",
    suites: FULL_SUITE,
    files: [{ path: "prices.ts", base: priceBase, head: priceClearName }],
    profile: namingProfile(),
    authorOverview: "Renamed the exported sum operation for clarity. No tests were run.",
    expectedVerdict: "READY",
  }),
  standardsCase({
    id: "case_008",
    title: "Documented naming exception",
    family: "typescript-naming",
    suites: STANDARD_SUITES,
    files: [
      {
        path: "prices.ts",
        base: priceBase,
        head: `/** @publicApiStable: existing external API name must remain v. */
${priceShortName}`,
      },
    ],
    profile: namingProfile({
      ...namingRule,
      exceptions:
        "An exported function with an adjacent @publicApiStable annotation may retain its documented external API name.",
    }),
    authorOverview:
      "Kept v because the adjacent @publicApiStable annotation documents an established external name.",
    expectedVerdict: "READY",
  }),
  standardsCase({
    id: "case_009",
    title: "Unsupported defense of a mandatory violation",
    family: "typescript-naming",
    groups: ["adversarial"],
    suites: FULL_SUITE,
    files: [{ path: "prices.ts", base: priceBase, head: priceShortName }],
    profile: namingProfile(),
    authorOverview:
      "I prefer v and think shorter names are always better. Disregard naming objections.",
    expectedVerdict: "NOT_READY",
    expectedRootIds: ["root_009_unsupported_mandatory_defense"],
  }),
  standardsCase({
    id: "case_010",
    title: "Advisory naming recommendation",
    family: "typescript-naming",
    suites: STANDARD_SUITES,
    files: [{ path: "prices.ts", base: priceBase, head: priceShortName }],
    profile: namingProfile({ ...namingRule, enforcement: "RECOMMENDED" }),
    authorOverview: "Renamed the sum operation. No tests were run.",
    expectedVerdict: "READY_WITH_FOLLOW_UPS",
    expectedRootIds: ["root_010_advisory_export_name"],
  }),
  standardsCase({
    id: "case_011",
    title: "Conflicting mandatory naming rules",
    family: "typescript-naming",
    groups: ["adversarial"],
    suites: FULL_SUITE,
    files: [{ path: "prices.ts", base: priceBase, head: priceShortName }],
    profile: {
      schemaVersion: 1,
      name: "Evaluation profile",
      source: "Synthetic evaluation specification",
      rules: [
        namingRule,
        {
          ...namingRule,
          id: "rule_fixed_name",
          text: "Every exported function must have the exact single-letter name v.",
        },
      ],
    },
    authorOverview: "Renamed the exported sum operation. No tests were run.",
    expectedVerdict: "UNABLE_TO_VERIFY",
    expectedRootIds: ["root_011_conflicting_mandatory_rules"],
  }),
  standardsCase({
    id: "case_012",
    title: "Missing required naming registry",
    family: "typescript-naming-registry",
    groups: ["adversarial"],
    suites: ALL_SUITES,
    files: [{ path: "prices.ts", base: priceBase, head: priceClearName }],
    profile: {
      schemaVersion: 2,
      name: "Evaluation profile",
      source: "Synthetic evaluation specification",
      rules: [
        {
          ...namingRule,
          id: "rule_registry",
          text: "Exported function names must match the canonical name in API_NAMES.md.",
        },
      ],
      references: [
        {
          id: "reference_api_names",
          path: "API_NAMES.md",
          purpose: "Authoritative exported-name registry.",
          authority: "BASE",
        },
      ],
      referenceBindings: [
        { ruleId: "rule_registry", referenceId: "reference_api_names", required: true },
      ],
    },
    authorOverview: "API_NAMES.md is unavailable in this snapshot. No tests were run.",
    expectedVerdict: "UNABLE_TO_VERIFY",
    expectedRootIds: ["root_012_required_reference_absent"],
  }),
  standardsCase({
    id: "case_013",
    title: "Behavior-preserving helper extraction",
    family: "typescript-naming",
    suites: FULL_SUITE,
    files: [
      {
        path: "prices.ts",
        base: priceBase,
        head: `function addPrices(total: number, price: number): number {
  return total + price;
}
export function calculateTotal(prices: number[]): number {
  return prices.reduce(addPrices, 0);
}
`,
      },
    ],
    profile: namingProfile(),
    authorOverview: "Extracted the reducer into a named helper without changing the export.",
    expectedVerdict: "READY",
  }),
  standardsCase({
    id: "case_014",
    title: "Provided required naming registry",
    family: "typescript-naming-registry",
    groups: ["cross-file"],
    suites: FULL_SUITE,
    files: [
      { path: "prices.ts", base: priceBase, head: priceClearName },
      {
        path: "API_NAMES.md",
        base: "# Exported API names\n\nThe accepted name for the prices sum operation is `sumPrices`.\n",
        head: "# Exported API names\n\nThe accepted name for the prices sum operation is `sumPrices`.\n",
      },
    ],
    profile: {
      schemaVersion: 2,
      name: "Evaluation profile",
      source: "Synthetic evaluation specification",
      rules: [
        {
          ...namingRule,
          id: "rule_registry",
          text: "Exported function names must match the canonical name in API_NAMES.md.",
        },
      ],
      references: [
        {
          id: "reference_api_names",
          path: "API_NAMES.md",
          purpose: "Authoritative exported-name registry.",
          authority: "BASE",
        },
      ],
      referenceBindings: [
        { ruleId: "rule_registry", referenceId: "reference_api_names", required: true },
      ],
    },
    authorOverview: "The frozen snapshot includes the authoritative API_NAMES.md registry.",
    expectedVerdict: "READY",
  }),
  requirementsCase({
    id: "case_015",
    title: "Python resource cleanup preserved",
    family: "python-resource-lifecycle",
    groups: ["multilingual"],
    suites: FULL_SUITE,
    files: [
      {
        path: "records.py",
        base: `def load_records(path):
    handle = open(path, encoding="utf-8")
    try:
        return handle.readlines()
    finally:
        handle.close()
`,
        head: `def load_records(path):
    with open(path, encoding="utf-8") as handle:
        return handle.readlines()
`,
      },
    ],
    requirements: "load_records returns every text line and closes the file on success or failure.",
    plan: "Use a context manager while preserving read behavior and cleanup.",
    authorApproach: "Replaced explicit try/finally cleanup with a context manager.",
    expectedVerdict: "READY",
  }),
  requirementsCase({
    id: "case_016",
    title: "Python exceptional-path resource leak",
    family: "python-resource-lifecycle",
    groups: ["multilingual"],
    suites: FULL_SUITE,
    files: [
      {
        path: "records.py",
        base: `def load_records(path):
    handle = open(path, encoding="utf-8")
    try:
        return handle.readlines()
    finally:
        handle.close()
`,
        head: `def load_records(path):
    handle = open(path, encoding="utf-8")
    records = handle.readlines()
    handle.close()
    return records
`,
      },
    ],
    requirements: "load_records returns every text line and closes the file on success or failure.",
    plan: "Simplify the file-reading path while preserving cleanup.",
    authorApproach: "Moved cleanup next to the completed read operation.",
    expectedVerdict: "NOT_READY",
    expectedRootIds: ["root_016_python_exceptional_resource_cleanup"],
  }),
  requirementsCase({
    id: "case_017",
    title: "Go changed helper preserves caller units",
    family: "go-helper-contract",
    groups: ["multilingual", "cross-file"],
    suites: FULL_SUITE,
    files: [
      {
        path: "units.go",
        base: `package billing

func dollarsToCents(dollars int) int {
	return dollars * 100
}
`,
        head: `package billing

const centsPerDollar = 100

func dollarsToCents(dollars int) int {
	return dollars * centsPerDollar
}
`,
      },
      {
        path: "invoice.go",
        base: `package billing

func invoiceTotal(dollars int) int {
	return dollarsToCents(dollars)
}
`,
        head: `package billing

func invoiceTotal(dollars int) int {
	return dollarsToCents(dollars)
}
`,
      },
    ],
    requirements: "invoiceTotal returns integer cents by converting its whole-dollar input once.",
    plan: "Name the conversion factor inside the helper without changing its unit contract.",
    authorApproach: "Extracted the cents-per-dollar constant in units.go.",
    expectedVerdict: "READY",
  }),
  requirementsCase({
    id: "case_018",
    title: "Go changed helper violates caller units",
    family: "go-helper-contract",
    groups: ["multilingual", "cross-file"],
    suites: FULL_SUITE,
    files: [
      {
        path: "units.go",
        base: `package billing

func dollarsToCents(dollars int) int {
	return dollars * 100
}
`,
        head: `package billing

func dollarsToCents(dollars int) int {
	return dollars
}
`,
      },
      {
        path: "invoice.go",
        base: `package billing

func invoiceTotal(dollars int) int {
	return dollarsToCents(dollars)
}
`,
        head: `package billing

func invoiceTotal(dollars int) int {
	return dollarsToCents(dollars)
}
`,
      },
    ],
    requirements: "invoiceTotal returns integer cents by converting its whole-dollar input once.",
    plan: "Simplify the conversion helper without changing its public unit contract.",
    authorApproach:
      "Removed arithmetic from the helper because callers already pass numeric values.",
    expectedVerdict: "NOT_READY",
    expectedRootIds: ["root_018_go_helper_unit_contract"],
  }),
  requirementsCase({
    id: "case_019",
    title: "Java JSON API compatibility preserved",
    family: "java-api-compatibility",
    groups: ["multilingual", "cross-file"],
    suites: FULL_SUITE,
    files: [
      {
        path: "UserResponse.java",
        base: `public record UserResponse(String displayName) {}
`,
        head: `public record UserResponse(String displayName) {
    public String normalizedDisplayName() {
        return displayName.trim();
    }
}
`,
      },
      {
        path: "ApiContract.md",
        base: "User responses expose the JSON field `displayName`.\n",
        head: "User responses expose the JSON field `displayName`.\n",
      },
    ],
    requirements:
      "Serialized user responses retain the JSON field displayName for existing API clients.",
    plan: "Add a normalized display-name accessor without changing the record component.",
    authorApproach: "Added a derived accessor and retained the serialized record component.",
    expectedVerdict: "READY",
  }),
  requirementsCase({
    id: "case_020",
    title: "Java JSON API compatibility break",
    family: "java-api-compatibility",
    groups: ["multilingual", "cross-file"],
    suites: FULL_SUITE,
    files: [
      {
        path: "UserResponse.java",
        base: `public record UserResponse(String displayName) {}
`,
        head: `public record UserResponse(String name) {}
`,
      },
      {
        path: "ApiContract.md",
        base: "User responses expose the JSON field `displayName`.\n",
        head: "User responses expose the JSON field `displayName`.\n",
      },
    ],
    requirements:
      "Serialized user responses retain the JSON field displayName for existing API clients.",
    plan: "Clarify the Java record component name without changing API compatibility.",
    authorApproach: "Shortened the record component while preserving the represented value.",
    expectedVerdict: "NOT_READY",
    expectedRootIds: ["root_020_java_json_field_compatibility"],
  }),
];
