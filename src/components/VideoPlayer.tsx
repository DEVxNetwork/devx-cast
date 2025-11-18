import { useRef, useEffect } from "react";

type VideoPlayerProps = {
  stream: MediaStream | null;
  autoPlay?: boolean;
  playsInline?: boolean;
  muted?: boolean;
};

export function VideoPlayer({ stream, autoPlay = true, playsInline = true, muted = false }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    } else if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, [stream]);

  return (
    <div className="video-player" style={{ marginTop: "1rem" }}>
      <video ref={videoRef} autoPlay={autoPlay} playsInline={playsInline} muted={muted} />
    </div>
  );
}

