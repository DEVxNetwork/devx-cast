import { useRef, useEffect } from "react";

type PeerVideoContainerProps = {
  peerId: string;
  stream: MediaStream | null;
  label: string;
  onVideoRef: (peerId: string, element: HTMLVideoElement | null) => void;
};

export function PeerVideoContainer({ peerId, stream, label, onVideoRef }: PeerVideoContainerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) {
      onVideoRef(peerId, videoRef.current);
      if (stream && videoRef.current.srcObject !== stream) {
        videoRef.current.srcObject = stream;
      }
    }
    return () => {
      if (videoRef.current) {
        onVideoRef(peerId, null);
      }
    };
  }, [peerId, stream, onVideoRef]);

  return (
    <div className="peer-video-container">
      {stream ? (
        <video ref={videoRef} autoPlay playsInline muted controls />
      ) : (
        <span>{label ?? ""}</span>
      )}
    </div>
  );
}

