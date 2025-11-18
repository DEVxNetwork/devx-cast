import { OptionCard } from "./OptionCard";
import { ErrorMessage } from "./ErrorMessage";
import { StatusDisplay } from "./StatusDisplay";
import { VideoPlayer } from "./VideoPlayer";

type ViewStatus = "idle" | "connecting" | "connected" | "error";

const viewStatusCopy: Record<ViewStatus, string> = {
  idle: "Not viewing",
  connecting: "Connecting…",
  connected: "Viewing stream",
  error: "View failed",
};

type ViewStreamCardProps = {
  viewStatus: ViewStatus;
  viewError: string | null;
  stream: MediaStream | null;
  onViewClick: () => void;
};

export function ViewStreamCard({ viewStatus, viewError, stream, onViewClick }: ViewStreamCardProps) {
  const isViewActive = viewStatus !== "idle" && viewStatus !== "error";
  const viewButtonDisabled = viewStatus === "connecting";

  return (
    <OptionCard
      title="View stream"
      description="Verify the host signature, connect, and watch the trusted broadcast feed. You only receive what the host is streaming."
    >
      <ErrorMessage message={viewError} />
      <StatusDisplay status={viewStatusCopy[viewStatus]} />
      <button
        className="btn btn-secondary"
        type="button"
        onClick={onViewClick}
        disabled={viewButtonDisabled}
      >
        {isViewActive ? "Stop viewing" : "View stream"}
      </button>
      {isViewActive && <VideoPlayer stream={stream} />}
    </OptionCard>
  );
}

