// src/lib/diffUtils.ts
import * as diff from "diff";

export interface DiffChange {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export function computeFileDiff(
  oldContent: string,
  newContent: string,
): DiffChange[] {
  return diff.diffLines(oldContent, newContent);
}
