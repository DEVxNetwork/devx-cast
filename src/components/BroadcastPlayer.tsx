import { useRef, useEffect } from "react";

type BroadcastPlayerProps = {
  stream: MediaStream | null;
  peerLabel: string | null;
  peerScreenTitle: string | null;
};

export function BroadcastPlayer({ stream, peerLabel, peerScreenTitle }: BroadcastPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    } else if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, [stream]);

  const hasActivePeer = !!stream;

  return (
    <div className="broadcast-player" data-empty={!hasActivePeer}>
      {hasActivePeer ? (
        <>
          <video ref={videoRef} autoPlay playsInline muted />
          <div className="broadcast-info">
            <p className="broadcast-title">{peerLabel}</p>
            <p className="broadcast-subtitle">{peerScreenTitle}</p>
          </div>
        </>
      ) : (
        <p>No active stream selected</p>
      )}
    </div>
  );
}

