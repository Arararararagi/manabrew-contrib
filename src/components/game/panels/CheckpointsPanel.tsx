import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { CheckpointDto, DecisionHistoryDto } from "@/protocol/game";
import { stepLabel } from "../game.utils";
interface CheckpointsPanelProps {
  checkpoints: CheckpointDto[];
  decisionHistory?: DecisionHistoryDto;
  canRequestRestore: boolean;
  onRequestRestore: (checkpoint: CheckpointDto) => void;
  resolvePlayerName: (playerId: string) => string;
  snapshotRecording: boolean;
  hostsEngine: boolean;
  onSnapshotRecordingChange: (enabled: boolean) => void;
}
function groupByTurn(checkpoints: CheckpointDto[]): [number, CheckpointDto[]][] {
  const turns = new Map<number, CheckpointDto[]>();
  for (const checkpoint of checkpoints) {
    turns.set(checkpoint.turn, [...(turns.get(checkpoint.turn) ?? []), checkpoint]);
  }
  return [...turns.entries()].reverse();
}
export function CheckpointsPanel({
  checkpoints,
  decisionHistory,
  canRequestRestore,
  onRequestRestore,
  resolvePlayerName,
  snapshotRecording,
  hostsEngine,
  onSnapshotRecordingChange,
}: CheckpointsPanelProps) {
  return (
    <div className="rounded-lg p-2.5 min-h-0 flex-1 flex flex-col bg-muted/20">
      <p className="text-xs font-semibold text-muted-foreground mb-2">
        {decisionHistory ? "Decision journal" : "Snapshots"}
      </p>
      {decisionHistory ? (
        <p className="text-xs text-muted-foreground mb-2" role="status">
          {decisionHistory.unavailableReason ??
            (decisionHistory.rewinding
              ? "Replaying the game…"
              : "Choose a decision to rewind to just before it. The latest 200 decisions are shown.")}
        </p>
      ) : (
        <label className="flex items-center gap-2 text-xs mb-1">
          <Checkbox
            checked={snapshotRecording}
            disabled={!hostsEngine}
            onCheckedChange={(checked) => onSnapshotRecordingChange(checked === true)}
          />
          Take snapshots
        </label>
      )}
      {!decisionHistory && !hostsEngine && (
        <p className="text-[10px] text-muted-foreground mb-2">
          Only the engine host can change this.
        </p>
      )}
      {checkpoints.length === 0 ? (
        <p className="text-xs text-muted-foreground italic mt-1">
          {decisionHistory
            ? "No decisions yet."
            : snapshotRecording
              ? `No snapshots yet.`
              : `Snapshots are off.`}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1 flex flex-col gap-2">
          {groupByTurn(checkpoints).map(([turn, steps]) => (
            <section key={turn} className="rounded-md border border-border/40 p-2">
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className="text-xs font-semibold text-foreground">{`Turn ${turn}`}</span>
                <span className="text-[10px] text-muted-foreground truncate">
                  {resolvePlayerName(steps[0]!.activePlayerId)}
                </span>
              </div>
              <ol className="flex flex-col">
                {(decisionHistory ? steps.slice().reverse() : steps).map((checkpoint) => (
                  <li key={checkpoint.checkpointId}>
                    <button
                      type="button"
                      className={cn(
                        "w-full rounded px-2 py-1 pointer-coarse:min-h-11 text-left text-xs text-muted-foreground",
                        "enabled:hover:bg-accent enabled:hover:text-accent-foreground",
                        "disabled:opacity-50",
                      )}
                      disabled={!canRequestRestore}
                      onClick={() => onRequestRestore(checkpoint)}
                    >
                      {checkpoint.decision ? (
                        <>
                          <span className="block text-foreground">{checkpoint.decision}</span>
                          <span className="block text-[10px]">
                            #{checkpoint.checkpointId} · {stepLabel(checkpoint.step)} ·{" "}
                            {resolvePlayerName(
                              checkpoint.decidingPlayerId ?? checkpoint.activePlayerId,
                            )}
                          </span>
                        </>
                      ) : (
                        stepLabel(checkpoint.step)
                      )}
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
