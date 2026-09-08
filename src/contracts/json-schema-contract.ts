/**
 * JSON Schema cannot portably express every relational invariant in the
 * runtime contracts. Schema-only success is therefore never artifact
 * acceptance.
 */
export const STRUCTURAL_JSON_SCHEMA_COMMENT_V1 =
  "This JSON Schema validates structural constraints only. Contract acceptance also requires versioned semantic validation by the Independent Reviewer runtime or an equivalent implementation.";
