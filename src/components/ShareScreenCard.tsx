import { OptionCard } from "./OptionCard";
import { TextInput } from "./TextInput";
import { ErrorMessage } from "./ErrorMessage";
import { StatusDisplay } from "./StatusDisplay";

type ShareStatus = "idle" | "prompting" | "publishing" | "awaiting" | "connected" | "error";

const shareStatusCopy: Record<ShareStatus, string> = {
  idle: "Not sharing",
  prompting: "Waiting for screen selection…",
  publishing: "Publishing offer…",
  awaiting: "Waiting for host to accept…",
  connected: "Streaming to host",
  error: "Share failed",
};

type ShareScreenCardProps = {
  shareStatus: ShareStatus;
  shareError: string | null;
  shareAlias: string;
  onAliasChange: (alias: string) => void;
  onShareClick: () => void;
};

export function ShareScreenCard({
  shareStatus,
  shareError,
  shareAlias,
  onAliasChange,
  onShareClick,
}: ShareScreenCardProps) {
  const isShareActive = shareStatus !== "idle" && shareStatus !== "error";

  return (
    <OptionCard
      title="Share screen"
      description="Start a WebRTC session to push your screen into the host console. Your request is signed against the host key so the host can trust it."
    >
      <TextInput
        label="Display name"
        value={shareAlias}
        onChange={onAliasChange}
        placeholder="Guest share"
      />
      <ErrorMessage message={shareError} />
      <StatusDisplay status={shareStatusCopy[shareStatus]} />
      <button
        className="btn btn-secondary"
        type="button"
        onClick={onShareClick}
      >
        {isShareActive ? "Stop sharing" : "Share screen"}
      </button>
    </OptionCard>
  );
}

