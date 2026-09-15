#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { EVALUATION_CORPUS_V1, validateEvaluationCorpusDefinitionV1 } from "./corpus.js";
import { reconstructEvaluationCorpusV1 } from "./corpus-reconstruction.js";

interface ReconstructCorpusIoV1 {
  stdout(message: string): void;
  stderr(message: string): void;
}

const processIo: ReconstructCorpusIoV1 = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
};

function parseOutputPath(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== "--output" || !args[1]?.trim()) {
    throw new Error("Usage: reconstruct corpus --output <directory>.");
  }
  return resolve(args[1]);
}

export async function runReconstructCorpusV1(
  args: readonly string[],
  io: ReconstructCorpusIoV1 = processIo,
): Promise<number> {
  try {
    const outputRoot = parseOutputPath(args);
    const definition = validateEvaluationCorpusDefinitionV1(EVALUATION_CORPUS_V1);
    await reconstructEvaluationCorpusV1(outputRoot);
    const pairedCases = definition.cases.filter(({ pair }) => pair !== null).length;
    const controls = definition.cases.length - pairedCases;
    io.stdout(
      `Reconstructed ${definition.cases.length} cases: ${pairedCases} paired cases and ${controls} controls.`,
    );
    io.stdout(`Evaluator artifacts: ${resolve(outputRoot, "evaluator")}`);
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "Unknown corpus reconstruction failure.");
    return 1;
  }
}

const executablePath = process.argv[1];
if (executablePath && import.meta.url === pathToFileURL(resolve(executablePath)).href) {
  process.exitCode = await runReconstructCorpusV1(process.argv.slice(2));
}
