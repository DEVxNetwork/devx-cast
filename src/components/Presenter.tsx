import { useState, useRef, useEffect } from "react";

interface PendingOffer {
  offerId: string;
  offer: string;
}

interface CasterStream {
  offerId: string;
  pc: RTCPeerConnection;
  stream: MediaStream | null;
}

export function Presenter() {
  const [pendingOffers, setPendingOffers] = useState<Map<string, PendingOffer>>(new Map());
  const [casters, setCasters] = useState<Map<string, CasterStream>>(new Map());
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const eventSourceRef = useRef<EventSource | null>(null);
  const castersRef = useRef<Map<string, CasterStream>>(new Map());

  function makePeer(offerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      iceCandidatePoolSize: 0,
    });

    return pc;
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

  const handleNewOffer = (offerId: string, offerString: string) => {
    // Only add if not already pending or active
    setPendingOffers((prevPending) => {
      // Skip if already pending
      if (prevPending.has(offerId)) {
        return prevPending;
      }
      // Skip if already accepted
      if (castersRef.current.has(offerId)) {
        return prevPending;
      }
      
      const updated = new Map(prevPending);
      updated.set(offerId, { offerId, offer: offerString });
      return updated;
    });
  };

  const handleAcceptOffer = async (offerId: string) => {
    const pendingOffer = pendingOffers.get(offerId);
    if (!pendingOffer) return;

    try {
      const offer = JSON.parse(pendingOffer.offer);
      console.log("Accepting offer:", offerId, offer);
      const pc = makePeer(offerId);

      // Ensure an entry exists for this caster before tracks arrive
      setCasters(prev => {
        const updated = new Map(prev);
        const existing = updated.get(offerId);
        const casterEntry: CasterStream = {
          offerId,
          pc,
          stream: existing?.stream ?? null,
        };
        updated.set(offerId, casterEntry);
        castersRef.current = updated;
        return updated;
      });

      pc.ontrack = (event) => {
        console.log("Received track event for offerId:", offerId, event.track, event.streams);
        
        // Create or get the stream for this caster
        setCasters((prev) => {
          const updated = new Map(prev);
          const existing = updated.get(offerId);
          if (existing) {
            let stream: MediaStream | null = existing.stream;
            
            // If no stream exists or stream has no tracks, create/get one
            if (!stream || stream.getTracks().length === 0) {
              // Try to get stream from event, or create a new one
              const eventStream = event.streams && event.streams.length > 0 ? event.streams[0] : null;
              if (eventStream && eventStream.getTracks().length > 0) {
                stream = eventStream;
              } else if (event.track) {
                // Create a new stream and add the track
                stream = new MediaStream();
                stream.addTrack(event.track);
              }
            } else {
              // Stream exists, add the new track if it's not already there
              if (event.track && !stream.getTracks().includes(event.track)) {
                stream.addTrack(event.track);
              }
            }
            
            if (stream) {
              console.log("Stream after processing:", stream, stream.getTracks());
              const updatedCaster = { ...existing, stream };
              updated.set(offerId, updatedCaster);
              castersRef.current = updated;
            }
          }
          return updated;
        });
      };

      pc.oniceconnectionstatechange = () => {
        console.log(`ICE connection state for ${offerId}:`, pc.iceConnectionState);
      };

      pc.onconnectionstatechange = () => {
        console.log(`Connection state for ${offerId}:`, pc.connectionState);
      };

      await pc.setRemoteDescription(offer);
      console.log("Set remote description, creating answer...");
      const answer = await pc.createAnswer();
      console.log("Created answer:", answer);
      
      try {
        await pc.setLocalDescription(answer);
        console.log("Set local description successfully");
      } catch (err) {
        console.error("Failed to set local description:", err);
        throw new Error(`Failed to set local description: ${err instanceof Error ? err.message : String(err)}`);
      }
      
      console.log("Waiting for ICE gathering...");
      await waitForIceGathering(pc);
      console.log("ICE gathering complete, sending answer to server...");

      if (pc.localDescription) {
        // POST answer to server
        const response = await fetch(`/api/answer/${offerId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer: pc.localDescription }),
        });
        
        if (!response.ok) {
          const error = await response.json();
          console.error("Failed to send answer:", error);
          return;
        }
        
        console.log("Answer sent successfully");
      }

      // Remove from pending and add to active casters
      setPendingOffers((prev) => {
        const updated = new Map(prev);
        updated.delete(offerId);
        return updated;
      });
    } catch (err) {
      console.error("Failed to accept offer:", err);
      alert("Failed to accept offer: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleDenyOffer = (offerId: string) => {
    setPendingOffers((prev) => {
      const updated = new Map(prev);
      updated.delete(offerId);
      return updated;
    });
  };

  const handleFullscreen = async (offerId: string) => {
    const caster = casters.get(offerId);
    if (!caster || !caster.stream) return;

    const video = document.createElement("video");
    video.srcObject = caster.stream;
    video.autoplay = true;
    video.controls = true;
    video.style.width = "100%";
    video.style.height = "100%";
    video.style.objectFit = "contain";

    const container = document.createElement("div");
    container.style.position = "fixed";
    container.style.top = "0";
    container.style.left = "0";
    container.style.width = "100vw";
    container.style.height = "100vh";
    container.style.backgroundColor = "#000000";
    container.style.zIndex = "9999";
    container.style.display = "flex";
    container.style.alignItems = "center";
    container.style.justifyContent = "center";
    container.appendChild(video);

    const closeButton = document.createElement("button");
    closeButton.textContent = "Close";
    closeButton.className = "action-button";
    closeButton.style.position = "absolute";
    closeButton.style.top = "20px";
    closeButton.style.right = "20px";
    closeButton.onclick = () => {
      document.body.removeChild(container);
    };
    container.appendChild(closeButton);

    document.body.appendChild(container);

    try {
      await video.play();
    } catch (err) {
      console.error("Failed to play video:", err);
    }
  };

  useEffect(() => {
    // Listen for new offers via SSE
    const eventSource = new EventSource("/api/offers/stream");
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const { offerId, offer } = JSON.parse(event.data);
        handleNewOffer(offerId, offer);
      } catch (err) {
        console.error("Failed to parse offer:", err);
      }
    };

    eventSource.onerror = (err) => {
      console.error("SSE error:", err);
    };

    return () => {
      eventSource.close();
    };
  }, []);

  // Clean up peer connections on unmount
  useEffect(() => {
    return () => {
      casters.forEach((caster) => {
        caster.pc.close();
      });
    };
  }, [casters]);

  const setVideoRef = (offerId: string, element: HTMLVideoElement | null) => {
    if (element) {
      videoRefs.current.set(offerId, element);
      const caster = casters.get(offerId);
      if (caster?.stream) {
        element.srcObject = caster.stream;
        element.pause();
      }
    } else {
      videoRefs.current.delete(offerId);
    }
  };

  // Update video elements when streams become available
  useEffect(() => {
    casters.forEach((caster, offerId) => {
      if (caster.stream && caster.stream.getTracks().length > 0) {
        const video = videoRefs.current.get(offerId);
        if (video && video.srcObject !== caster.stream) {
          video.srcObject = caster.stream;
          // Video will be paused by default, user can play via controls
        }
      }
    });
  }, [casters]);

  return (
    <div className="presenter-container">
      <div className="instructions">
        <p>
          Incoming screen share requests will appear below. Accept or deny each request, then view active streams in fullscreen.
        </p>
      </div>

      {(pendingOffers.size === 0 && casters.size === 0) && (
        <div className="connection-status">
          Waiting for casters to connect...
        </div>
      )}

      <div className="casters-grid">
        {/* Pending offers */}
        {Array.from(pendingOffers.entries()).map(([offerId, pendingOffer]) => (
          <div key={offerId} className="caster-video-container">
            <div className="video-placeholder">
              <div className="placeholder-content">
                <p>Screen Share Request</p>
                <p className="placeholder-id">ID: {offerId.substring(0, 8)}...</p>
              </div>
            </div>
            <div className="placeholder-actions">
              <button
                onClick={() => handleAcceptOffer(offerId)}
                className="action-button"
                style={{ flex: 1, marginRight: "0.5rem" }}
              >
                Accept
              </button>
              <button
                onClick={() => handleDenyOffer(offerId)}
                className="action-button"
                style={{ 
                  flex: 1, 
                  background: "#333333",
                  color: "#ffffff"
                }}
              >
                Deny
              </button>
            </div>
          </div>
        ))}

        {/* Active casters */}
        {Array.from(casters.entries()).map(([offerId, caster]) => (
          <div key={offerId} className="caster-video-container">
            {caster.stream ? (
              <>
                <video
                  ref={(el) => setVideoRef(offerId, el)}
                  className="video-player"
                  playsInline
                  controls
                  muted
                />
                <button
                  onClick={() => handleFullscreen(offerId)}
                  className="action-button"
                  style={{ marginTop: "0.5rem", width: "100%" }}
                >
                  View Fullscreen
                </button>
              </>
            ) : (
              <div className="video-placeholder">
                <div className="placeholder-content">
                  <p>Connecting...</p>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
