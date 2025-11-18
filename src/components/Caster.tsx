import { useEffect, useMemo, useRef, useState } from "react";
import {
  createOffer,
  fetchExistingAnswer,
  generateRoomCode,
  subscribeToAnswer,
  updateOfferStatus,
} from "../lib/signaling";

type CasterStep = "idle" | "preparing" | "awaiting" | "connected" | "error";

function createDummyVideoStream(): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get canvas context");

  let frame = 0;
  const drawFrame = () => {
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    const hue = (frame * 2) % 360;
    gradient.addColorStop(0, `hsl(${hue}, 70%, 50%)`);
    gradient.addColorStop(1, `hsl(${(hue + 90) % 360}, 70%, 50%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(40, 40, canvas.width - 80, canvas.height - 80);

    ctx.fillStyle = "#fff";
    ctx.font = "48px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("DevX Cast • Dummy Stream", canvas.width / 2, canvas.height / 2 - 30);
    ctx.font = "24px Inter, sans-serif";
    ctx.fillText(`Frame ${frame}`, canvas.width / 2, canvas.height / 2 + 20);

    frame++;
  };

  drawFrame();
  const stream = canvas.captureStream(30);
  const interval = setInterval(drawFrame, 1000 / 30);
  stream.getTracks().forEach((track) =>
    track.addEventListener("ended", () => {
      clearInterval(interval);
    })
  );
  return stream;
}

export function Caster() {
  const [casterName, setCasterName] = useState("Guest Caster");
  const [roomCode, setRoomCode] = useState(generateRoomCode());
  const [status, setStatus] = useState<CasterStep>("idle");
  const [statusMessage, setStatusMessage] = useState("Ready to broadcast");
  const [offerId, setOfferId] = useState<string | null>(null);
  const [rtcState, setRtcState] = useState<string>("disconnected");

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const unsubscribeRef = useRef<(() => Promise<void>) | null>(null);

  const inviteLink = useMemo(() => {
    if (typeof window === "undefined") return "";
    const url = new URL(window.location.origin + window.location.pathname);
    url.searchParams.set("role", "presenter");
    url.searchParams.set("room", roomCode);
    return url.toString();
  }, [roomCode]);

  const cleanup = async () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (pcRef.current) {
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    if (unsubscribeRef.current) {
      await unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
    setOfferId(null);
    setRtcState("disconnected");
  };

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, []);

  const makePeer = () => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      setRtcState(state);
      if (state === "connected") {
        setStatus("connected");
        setStatusMessage("Presenter connected");
      } else if (state === "failed" || state === "disconnected" || state === "closed") {
        setStatus("error");
        setStatusMessage("Connection ended");
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.debug("ICE state", pc.iceConnectionState);
    };

    pcRef.current = pc;
    return pc;
  };

  const waitForIceGathering = async (pc: RTCPeerConnection) => {
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
  };

  const handleStartShare = async () => {
    if (!casterName.trim()) {
      alert("Add a caster name so the presenter recognizes you.");
      return;
    }

    try {
      setStatus("preparing");
      setStatusMessage("Preparing media stream…");
      let stream: MediaStream | null = null;

      try {
        const realStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        if (realStream.getVideoTracks().length === 0) {
          realStream.getTracks().forEach((track) => track.stop());
          throw new Error("No tracks in real stream");
        }
        stream = realStream;
      } catch {
        stream = createDummyVideoStream();
        setStatusMessage("Using dummy stream (screen share blocked)");
      }

      streamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      const pc = makePeer();
      stream.getTracks().forEach((track) => pc.addTrack(track, stream as MediaStream));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);

      const sessionDesc = pc.localDescription;
      if (!sessionDesc) throw new Error("Failed to capture local session description");

      setStatus("awaiting");
      setStatusMessage("Publishing offer to Supabase…");

      const record = await createOffer({
        offer: sessionDesc,
        casterName: casterName.trim(),
        roomCode,
      });
      setOfferId(record.id);
      setStatusMessage("Waiting for presenter to connect…");

      const applyAnswer = async (answer: RTCSessionDescriptionInit) => {
        const description =
          typeof RTCSessionDescription !== "undefined" ? new RTCSessionDescription(answer) : answer;
        await pc.setRemoteDescription(description);
        setStatus("connected");
        setStatusMessage("Presenter accepted your stream");
      };

      unsubscribeRef.current = subscribeToAnswer(record.id, async (payload) => {
        await applyAnswer(payload.answer);
      });

      const existingAnswer = await fetchExistingAnswer(record.id);
      if (existingAnswer) await applyAnswer(existingAnswer.answer);
    } catch (err) {
      console.error(err);
      setStatus("error");
      setStatusMessage(err instanceof Error ? err.message : "Something went wrong");
      await cleanup();
    }
  };

  const handleStop = async () => {
    if (offerId) {
      await updateOfferStatus(offerId, "completed");
    }
    await cleanup();
    setRoomCode(generateRoomCode());
    setStatus("idle");
    setStatusMessage("Ready to broadcast");
  };

  return (
    <div className="caster-stack">
      <section className="panel">
        <header className="panel-header">
          <div>
            <p className="panel-eyebrow">STEP 1</p>
            <h3>Name your feed</h3>
            <p>Presenters see this label next to your room code.</p>
          </div>
          <button className="ghost-button" onClick={() => setRoomCode(generateRoomCode())}>
            New room code
          </button>
        </header>

        <label className="field">
          <span>Display name</span>
          <input value={casterName} onChange={(e) => setCasterName(e.target.value)} placeholder="Figma Demo" />
        </label>

        <div className="room-chip">
          <div>
            <p>Room code</p>
            <strong>{roomCode}</strong>
          </div>
          <button
            className="ghost-button"
            onClick={() => navigator.clipboard.writeText(roomCode).catch(() => null)}
          >
            Copy
          </button>
        </div>

        <div className="invite-link">
          <p>Invite link</p>
          <code>{inviteLink || "…"}</code>
          <button
            className="ghost-button"
            onClick={() => inviteLink && navigator.clipboard.writeText(inviteLink).catch(() => null)}
          >
            Copy link
          </button>
        </div>
      </section>

      <section className="panel">
        <header className="panel-header">
          <div>
            <p className="panel-eyebrow">STEP 2</p>
            <h3>Stream status</h3>
            <p>{statusMessage}</p>
          </div>
        </header>

        <div className="status-grid">
          <div className={`status-card ${status === "preparing" ? "active" : ""}`}>
            <span>1</span>
            <p>Capture stream</p>
          </div>
          <div className={`status-card ${status === "awaiting" ? "active" : ""}`}>
            <span>2</span>
            <p>Waiting for presenter</p>
          </div>
          <div className={`status-card ${status === "connected" ? "active" : ""}`}>
            <span>3</span>
            <p>Connected</p>
          </div>
        </div>

        <div className="preview-shell">
          <video ref={localVideoRef} autoPlay playsInline muted />
          <div className="preview-meta">
            <p>Peer status: {rtcState}</p>
            {offerId && (
              <p>
                Offer ID: <code>{offerId.slice(0, 8)}…</code>
              </p>
            )}
          </div>
        </div>

        <div className="controls-row">
          <button className="action-button" onClick={handleStartShare} disabled={status === "preparing" || status === "awaiting"}>
            {status === "idle" ? "Start screen share" : status === "connected" ? "Reconnect" : "Streaming…"}
          </button>
          <button className="ghost-button" onClick={handleStop} disabled={!offerId}>
            Stop session
          </button>
        </div>
      </section>
    </div>
  );
}

