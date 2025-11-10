import { useState, useRef, useEffect } from "react";

export function Streamer() {
  const [localSdp, setLocalSdp] = useState("");
  const [remoteSdp, setRemoteSdp] = useState("");
  const [isSharing, setIsSharing] = useState(false);
  const [connectionState, setConnectionState] = useState<string>("");
  
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  function makePeer() {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      iceCandidatePoolSize: 0,
    });

    pc.onicecandidate = (e) => {
      if (!e.candidate && pc.localDescription) {
        setLocalSdp(JSON.stringify(pc.localDescription));
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      setConnectionState(state);
      console.log("PC state:", state);
    };

    pcRef.current = pc;
  }

  async function waitForIceGathering(pc: RTCPeerConnection) {
    if (pc.iceGatheringState === "complete") return;
    await new Promise<void>((resolve) => {
      const check = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", check);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", check);
    });
  }

  const handleStartShare = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      streamRef.current = stream;
      setIsSharing(true);
      makePeer();

      if (pcRef.current) {
        stream.getTracks().forEach((track) => {
          pcRef.current?.addTrack(track, stream);
        });
      }
    } catch (err) {
      alert("Screen share failed: " + (err instanceof Error ? err.message : String(err)));
      console.error(err);
    }
  };

  const handleCreateOffer = async () => {
    if (!pcRef.current) return;

    try {
      const offer = await pcRef.current.createOffer();
      await pcRef.current.setLocalDescription(offer);
      await waitForIceGathering(pcRef.current);
      setLocalSdp(JSON.stringify(pcRef.current.localDescription));
    } catch (err) {
      alert("Offer failed: " + (err instanceof Error ? err.message : String(err)));
      console.error(err);
    }
  };

  const handleSetAnswer = async () => {
    if (!pcRef.current) return;

    try {
      const answer = JSON.parse(remoteSdp.trim());
      await pcRef.current.setRemoteDescription(answer);
      alert("Remote answer set. You are connected!");
    } catch (err) {
      alert("Setting remote answer failed: " + (err instanceof Error ? err.message : String(err)));
      console.error(err);
    }
  };

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (pcRef.current) {
        pcRef.current.close();
      }
    };
  }, []);

  return (
    <div className="streamer-container">
      <div className="instructions">
        <ol>
          <li>Click <b>Start Screen Share</b> and choose what to share.</li>
          <li>Click <b>Create Offer</b> and copy the "Local Offer" into the presenter page.</li>
          <li>Paste the presenter's "Remote Answer" back here and click <b>Set Remote Answer</b>.</li>
        </ol>
      </div>

      <div className="controls-row">
        <button onClick={handleStartShare} className="action-button">
          Start Screen Share
        </button>
        <button
          onClick={handleCreateOffer}
          disabled={!isSharing}
          className="action-button"
        >
          Create Offer
        </button>
        <button
          onClick={handleSetAnswer}
          disabled={!localSdp || !remoteSdp}
          className="action-button"
        >
          Set Remote Answer
        </button>
      </div>

      {connectionState && (
        <div className="connection-status">
          Connection: <span className={`status-${connectionState}`}>{connectionState}</span>
        </div>
      )}

      <div className="video-section">
        <h3>Local preview</h3>
        <video
          ref={localVideoRef}
          id="local"
          autoPlay
          playsInline
          muted
          className="video-player"
        />
      </div>

      <div className="sdp-section">
        <h3>Local Offer (copy to presenter)</h3>
        <textarea
          value={localSdp}
          readOnly
          className="sdp-textarea"
          placeholder="Local offer will appear here..."
        />
      </div>

      <div className="sdp-section">
        <h3>Remote Answer (paste from presenter)</h3>
        <textarea
          value={remoteSdp}
          onChange={(e) => setRemoteSdp(e.target.value)}
          className="sdp-textarea"
          placeholder="Paste remote answer here..."
        />
      </div>
    </div>
  );
}

