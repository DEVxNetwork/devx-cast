import { useState, useRef, useEffect } from "react";

export function Caster() {
  const [isSharing, setIsSharing] = useState(false);
  const [connectionState, setConnectionState] = useState<string>("");
  const [offerId, setOfferId] = useState<string>("");

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  function makePeer() {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      iceCandidatePoolSize: 0,
    });

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      setConnectionState(state);
      console.log("PC connection state:", state);
    };

    pc.oniceconnectionstatechange = () => {
      console.log("PC ICE connection state:", pc.iceConnectionState);
    };

    pc.ontrack = (event) => {
      console.log("Caster received track:", event.track, event.streams);
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

      // Create offer and send to server
      if (pcRef.current) {
        const offer = await pcRef.current.createOffer();
        await pcRef.current.setLocalDescription(offer);
        await waitForIceGathering(pcRef.current);

        if (pcRef.current.localDescription) {
          // POST offer to server
          const response = await fetch("/api/offer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ offer: pcRef.current.localDescription }),
          });

          if (response.ok) {
            const data = await response.json();
            setOfferId(data.offerId);

            // Listen for answer via SSE
            const eventSource = new EventSource(`/api/answers/stream/${data.offerId}`);
            eventSourceRef.current = eventSource;

            eventSource.onopen = () => {
              console.log("SSE connection opened for offerId:", data.offerId);
            };

            eventSource.onmessage = async (event) => {
              try {
                const rawData = (event.data ?? "").trim();

                // Ignore empty payloads or keepalive comments
                if (!rawData || rawData.startsWith(":")) {
                  return;
                }

                let parsedPayload: unknown;
                try {
                  parsedPayload = JSON.parse(rawData);
                } catch (parseError) {
                  console.error("Failed to parse answer event payload:", parseError, rawData);
                  return;
                }

                const { answer } = parsedPayload as { answer?: unknown };
                if (!pcRef.current || answer == null) {
                  return;
                }

                let answerPayload: unknown = answer;
                if (typeof answer === "string") {
                  try {
                    answerPayload = JSON.parse(answer);
                  } catch (parseError) {
                    console.error("Failed to parse answer JSON payload:", parseError, answer);
                    alert(
                      "Failed to process presenter response: " +
                        (parseError instanceof Error ? parseError.message : String(parseError))
                    );
                    return;
                  }
                }

                if (!answerPayload || typeof answerPayload !== "object") {
                  console.error("Answer payload missing expected structure:", answerPayload);
                  alert("Failed to process presenter response: invalid payload");
                  return;
                }

                const answerInitCandidate = answerPayload as Partial<RTCSessionDescriptionInit>;
                if (typeof answerInitCandidate.type !== "string" || typeof answerInitCandidate.sdp !== "string") {
                  console.error("Answer payload missing SDP fields:", answerPayload);
                  alert("Failed to process presenter response: incomplete SDP");
                  return;
                }

                const descriptionInit: RTCSessionDescriptionInit = {
                  type: answerInitCandidate.type,
                  sdp: answerInitCandidate.sdp,
                };

                const description =
                  typeof RTCSessionDescription !== "undefined"
                    ? new RTCSessionDescription(descriptionInit)
                    : descriptionInit;

                console.log("Setting remote description with answer:", descriptionInit);
                await pcRef.current.setRemoteDescription(description);
                console.log("Remote description set, connection should be establishing...");
                eventSource.close();
                eventSourceRef.current = null;
              } catch (err) {
                console.error("Failed to set remote description:", err);
                alert("Failed to set remote description: " + (err instanceof Error ? err.message : String(err)));
              }
            };

            eventSource.onerror = (err) => {
              console.error("SSE error:", err, "readyState:", eventSource.readyState);
              // EventSource.CONNECTING = 0, OPEN = 1, CLOSED = 2
              if (eventSource.readyState === EventSource.CLOSED) {
                console.log("SSE connection closed");
              }
            };
          }
        }
      }
    } catch (err) {
      alert("Screen share failed: " + (err instanceof Error ? err.message : String(err)));
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
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  return (
    <div className="caster-container">
      <div className="instructions">
        <p>Click <b>Start Screen Share</b> to begin sharing your screen. The connection will be established automatically.</p>
      </div>

      <div className="controls-row">
        <button onClick={handleStartShare} className="action-button" disabled={isSharing}>
          {isSharing ? "Sharing..." : "Start Screen Share"}
        </button>
      </div>

      {connectionState && (
        <div className="connection-status">
          Connection: <span className={`status-${connectionState}`}>{connectionState}</span>
        </div>
      )}

      {offerId && (
        <div className="connection-status">
          Offer ID: <code>{offerId}</code>
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
    </div>
  );
}

