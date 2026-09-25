import {
  type RunRecordEventPayloadV2,
  RunRecordEventV2Schema,
} from "../contracts/run-record-v2.js";
import {
  type AppendRunRecordOptionsV1,
  appendRunRecordEvent,
  readRunRecordEvents,
} from "./run-record.js";

export function appendRunRecordEventV2(
  path: string,
  payload: RunRecordEventPayloadV2,
  options: AppendRunRecordOptionsV1 = {},
) {
  return appendRunRecordEvent(path, payload, RunRecordEventV2Schema, 2, options);
}

export function readRunRecordEventsV2(
  path: string,
  options: { readonly maxTotalBytes: number; readonly maxLineBytes: number },
) {
  return readRunRecordEvents(path, options, RunRecordEventV2Schema);
}
