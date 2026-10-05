import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface BuildOutput {
  staged: string;
  target: string;
}

class RestoreFailed extends AggregateError {}

// Keep the old distribution until every build and packaging step has succeeded.
// Publication uses synchronous renames; if one fails, restore earlier outputs too.
function publishOutputs(stage: string, outputs: BuildOutput[]): void {
  const backups = join(stage, 'previous');
  mkdirSync(backups);
  const moved: Array<{ target: string; backup: string; installed: boolean }> = [];
  try {
    for (const [index, output] of outputs.entries()) {
      mkdirSync(dirname(output.target), { recursive: true });
      const backup = join(backups, String(index));
      if (existsSync(output.target)) renameSync(output.target, backup);
      const entry = { target: output.target, backup, installed: false };
      moved.push(entry);
      // An optional packaged file that was removed must disappear from the package too.
      if (existsSync(output.staged)) {
        renameSync(output.staged, output.target);
        entry.installed = true;
      }
    }
  } catch (error) {
    const errors: unknown[] = [error];
    for (const entry of moved.toReversed()) {
      try {
        if (entry.installed) rmSync(entry.target, { recursive: true, force: true });
        if (existsSync(entry.backup)) renameSync(entry.backup, entry.target);
      } catch (restoreError) {
        errors.push(restoreError);
      }
    }
    if (errors.length > 1) {
      throw new RestoreFailed(
        errors,
        `Could not restore build outputs. Backups remain in ${stage}`,
      );
    }
    throw error;
  }
}

export async function withStagedOutputs(
  stageParent: string,
  build: (stage: string) => Promise<BuildOutput[]>,
): Promise<void> {
  const stage = mkdtempSync(join(stageParent, '.build-'));
  let removeStage = true;
  try {
    publishOutputs(stage, await build(stage));
  } catch (error) {
    if (error instanceof RestoreFailed) removeStage = false;
    throw error;
  } finally {
    if (removeStage) {
      rmSync(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}
