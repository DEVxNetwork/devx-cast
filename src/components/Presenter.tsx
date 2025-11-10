import { useState, useRef, useEffect } from "react";

export function Presenter() {
  const [remoteSdp, setRemoteSdp] = useState("");
  const [localSdp, setLocalSdp] = useState("");
  const [connectionState, setConnectionState] = useState<string>("");

  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  function makePeer() {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      iceCandidatePoolSize: 0,
    });

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
      }
    };

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

  const handleCreateAnswer = async () => {
    if (!pcRef.current) {
      makePeer();
    }

    if (!pcRef.current) return;

    try {
      const offer = JSON.parse(remoteSdp.trim());
      await pcRef.current.setRemoteDescription(offer);
      const answer = await pcRef.current.createAnswer();
      await pcRef.current.setLocalDescription(answer);
      await waitForIceGathering(pcRef.current);
      setLocalSdp(JSON.stringify(pcRef.current.localDescription));
      alert("Answer created. Send it back to the sharer.");
    } catch (err) {
      alert("Answering failed: " + (err instanceof Error ? err.message : String(err)));
      console.error(err);
    }
  };

  useEffect(() => {
    return () => {
      if (pcRef.current) {
        pcRef.current.close();
      }
    };
  }, []);

  return (
    <div className="presenter-container">
      <div className="instructions">
        <ol>
          <li>Paste the sharer's "Local Offer" into the box below.</li>
          <li>
            Click <b>Accept Offer & Create Answer</b>, then copy the "Local Answer" back to the sharer.
          </li>
        </ol>
      </div>

      <div className="controls-row">
        <button
          onClick={handleCreateAnswer}
          disabled={!remoteSdp.trim()}
          className="action-button"
        >
          Accept Offer & Create Answer
        </button>
      </div>

      {connectionState && (
        <div className="connection-status">
          Connection: <span className={`status-${connectionState}`}>{connectionState}</span>
        </div>
      )}

      <div className="sdp-section">
        <h3>Remote Offer (paste from sharer)</h3>
        <textarea
          value={remoteSdp}
          onChange={(e) => setRemoteSdp(e.target.value)}
          className="sdp-textarea"
          placeholder="Paste remote offer here..."
        />
      </div>

      <div className="sdp-section">
        <h3>Local Answer (copy to sharer)</h3>
        <textarea
          value={localSdp}
          readOnly
          className="sdp-textarea"
          placeholder="Local answer will appear here..."
        />
      </div>

      <div className="video-section">
        <h3>Incoming stream</h3>
        <video
          ref={remoteVideoRef}
          id="remote"
          autoPlay
          playsInline
          controls
          className="video-player"
        />
      </div>
    </div>
  );
}

