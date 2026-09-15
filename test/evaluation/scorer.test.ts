import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateEvaluationArtifactGraphV1 } from "../../evaluation/artifact-graph.js";
import { scoreEvaluationArtifactsV1 } from "../../evaluation/scorer.js";
import { makeEvaluationGraph } from "./artifact-fixtures.js";

function artifactReferences(graph: ReturnType<typeof makeEvaluationGraph>) {
  return {
    cases: graph.cases.map(({ caseId }) => ({ caseId, reference: `cases/${caseId}.json` })),
    split: "split.json",
    experiment: "experiment.json",
    attempts: graph.attempts.map(({ attemptId }) => ({
      attemptId,
      reference: `attempts/${attemptId}.json`,
    })),
    adjudications: graph.adjudications.map(({ adjudicationId }) => ({
      adjudicationId,
      reference: `adjudications/${adjudicationId}.json`,
    })),
  };
}

describe("evaluation scorer", () => {
  it("builds a deterministic, graph-valid score from fixed evaluation artifacts", () => {
    const graph = makeEvaluationGraph();
    const input = {
      experiment: graph.experiment,
      split: graph.split,
      cases: graph.cases,
      attempts: graph.attempts,
      adjudications: graph.adjudications,
      scoreId: "score_generated",
      generatedAt: "2026-09-15T12:10:00.000Z",
      references: artifactReferences(graph),
    };

    const first = scoreEvaluationArtifactsV1(input);
    const second = scoreEvaluationArtifactsV1(input);

    assert.deepEqual(first, second);
    assert.doesNotThrow(() =>
      validateEvaluationArtifactGraphV1({
        experiment: graph.experiment,
        split: graph.split,
        cases: graph.cases,
        attempts: graph.attempts,
        adjudications: graph.adjudications,
        score: first,
      }),
    );
    assert.deepEqual(first.missingness, {
      startedAttempts: 4,
      deliveredReports: 4,
      missingReports: 0,
    });
  });
});
