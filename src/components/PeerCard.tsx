import { PeerVideoContainer } from "./PeerVideoContainer";

type PeerCardProps = {
  peerId: string;
  label: string;
  screenTitle: string;
  stream: MediaStream | null;
  isActive: boolean;
  onVideoRef: (peerId: string, element: HTMLVideoElement | null) => void;
  onHighlight: (peerId: string) => void;
};

export function PeerCard({
  peerId,
  label,
  screenTitle,
  stream,
  isActive,
  onVideoRef,
  onHighlight,
}: PeerCardProps) {
  return (
    <div className={`peer-card ${isActive ? "active" : ""}`}>
      <PeerVideoContainer peerId={peerId} stream={stream} label={label} onVideoRef={onVideoRef} />
      <div className="peer-info">
        <span className="peer-name">{label}</span>
        <p className="peer-description">{screenTitle}</p>
      </div>
      <button className="btn btn-primary" type="button" onClick={() => onHighlight(peerId)}>
        {isActive ? "Broadcasting" : "Switch broadcast"}
      </button>
    </div>
  );
}

