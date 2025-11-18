import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

type ShareStatus = "idle" | "prompting" | "publishing" | "awaiting" | "connected" | "error";
type ViewStatus = "idle" | "connecting" | "connected" | "error";

const shareStatusCopy: Record<ShareStatus, string> = {
  idle: "Not sharing",
  prompting: "Waiting for screen selection…",
  publishing: "Publishing offer…",
  awaiting: "Waiting for host to accept…",
  connected: "Streaming to host",
  error: "Share failed",
};

const viewStatusCopy: Record<ViewStatus, string> = {
  idle: "Not viewing",
  connecting: "Connecting…",
  connected: "Viewing stream",
  error: "View failed",
};

type HostKeyPair = {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyString: string;
};

type PeerOfferMessage = {
  peerId: string;
  alias: string;
  offer: RTCSessionDescriptionInit;
  nonce: string;
  timestamp: number;
};

type HostAnswerMessage = {
  peerId: string;
  nonce: string;
  answer: RTCSessionDescriptionInit;
  signature: string;
  timestamp: number;
};

type ShareSession = {
  peerId: string;
  nonce: string;
  hostKey: string;
  pc: RTCPeerConnection;
  stream: MediaStream;
  signalChannel: RealtimeChannel;
};

type ViewSession = {
  peerId: string;
  pc: RTCPeerConnection;
  stream: MediaStream | null;
  signalChannel: RealtimeChannel;
};

const textEncoder = new TextEncoder();

const arrayBufferToBase64Url = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const base64UrlToArrayBuffer = (value: string) => {
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

const getSignalChannelName = (hostKey: string) => `signal-${hostKey}`;

const PEER_OFFER_EVENT = "peer-offer";
const HOST_ANSWER_EVENT = "host-answer";
const HOST_TERMINATE_EVENT = "host-terminate";
const VIEW_OFFER_EVENT = "view-offer";
const VIEW_ANSWER_EVENT = "view-answer";

const subscribeToRealtimeChannel = (channel: RealtimeChannel) =>
  new Promise<void>((resolve, reject) => {
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        reject(new Error(`Channel ${channel.topic} status: ${status}`));
      }
    });
  });

const encodePayload = (payload: unknown) => textEncoder.encode(JSON.stringify(payload));

const importHostPublicKey = (publicKeyString: string) =>
  crypto.subtle.importKey(
    "spki",
    base64UrlToArrayBuffer(publicKeyString),
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["verify"]
  );

const verifyHostSignature = async (publicKey: CryptoKey, payload: object, signature: string) => {
  const signatureBuffer = base64UrlToArrayBuffer(signature);
  return crypto.subtle.verify(
    {
      name: "ECDSA",
      hash: "SHA-256",
    },
    publicKey,
    signatureBuffer,
    encodePayload(payload)
  );
};

const randomId = () => Math.random().toString(36).slice(2, 10);

const waitForIceGathering = async (pc: RTCPeerConnection) => {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const checkState = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", checkState);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", checkState);
  });
};

const createPeerConnection = () =>
  new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

type ChannelScreenProps = {
  hostKey: string;
  onBack: () => void;
};

export function ChannelScreen({ hostKey, onBack }: ChannelScreenProps) {
  const [shareStatus, setShareStatus] = useState<ShareStatus>("idle");
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareAlias, setShareAlias] = useState<string>("Guest share");
  const [viewStatus, setViewStatus] = useState<ViewStatus>("idle");
  const [viewError, setViewError] = useState<string | null>(null);

  const shareSessionRef = useRef<ShareSession | null>(null);
  const viewSessionRef = useRef<ViewSession | null>(null);
  const viewVideoRef = useRef<HTMLVideoElement | null>(null);
  const verifyKeyCacheRef = useRef<Map<string, CryptoKey>>(new Map());

  const getVerifyKey = useCallback(
    async (hostKey: string) => {
      const cached = verifyKeyCacheRef.current.get(hostKey);
      if (cached) return cached;
      const imported = await importHostPublicKey(hostKey);
      verifyKeyCacheRef.current.set(hostKey, imported);
      return imported;
    },
    []
  );

  const stopShareSession = useCallback(async () => {
    const session = shareSessionRef.current;
    if (!session) return;
    shareSessionRef.current = null;
    session.stream.getTracks().forEach((track) => track.stop());
    session.pc.onconnectionstatechange = null;
    session.pc.close();
    await session.signalChannel.unsubscribe().catch(() => null);
    setShareStatus("idle");
    setShareError(null);
  }, []);

  const stopViewSession = useCallback(async () => {
    const session = viewSessionRef.current;
    if (!session) return;
    viewSessionRef.current = null;
    if (session.stream) {
      session.stream.getTracks().forEach((track) => track.stop());
    }
    session.pc.onconnectionstatechange = null;
    session.pc.ontrack = null;
    session.pc.close();
    await session.signalChannel.unsubscribe().catch(() => null);
    if (viewVideoRef.current) {
      viewVideoRef.current.srcObject = null;
    }
    setViewStatus("idle");
    setViewError(null);
  }, []);

  const handleShareScreen = useCallback(async () => {
    if (shareSessionRef.current) {
      await stopShareSession();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setShareError("Screen sharing is not supported in this browser.");
      return;
    }
    setShareError(null);
    setShareStatus("prompting");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      if (!stream.getVideoTracks().length) {
        throw new Error("No video track captured");
      }

      const pc = createPeerConnection();
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const signalChannel = supabase.channel(getSignalChannelName(hostKey), {
        config: { broadcast: { self: true } },
      });
      const peerId = `peer_${randomId()}`;
      const nonce = `nonce_${randomId()}${randomId()}`;

      signalChannel.on("broadcast", { event: HOST_ANSWER_EVENT }, async ({ payload }) => {
        const message = payload as HostAnswerMessage;
        if (message.peerId !== peerId || message.nonce !== nonce) return;
        const verifyKey = await getVerifyKey(hostKey);
        const isValid = await verifyHostSignature(
          verifyKey,
          { peerId: message.peerId, nonce: message.nonce, answer: message.answer },
          message.signature
        );
        if (!isValid) {
          setShareError("Host signature is invalid.");
          await stopShareSession();
          return;
        }
        const description =
          typeof RTCSessionDescription !== "undefined"
            ? new RTCSessionDescription(message.answer)
            : message.answer;
        await pc.setRemoteDescription(description);
        setShareStatus("connected");
      });

      signalChannel.on("broadcast", { event: HOST_TERMINATE_EVENT }, () => {
        stopShareSession().catch(() => null);
      });

      await subscribeToRealtimeChannel(signalChannel);

      shareSessionRef.current = {
        peerId,
        nonce,
        hostKey,
        pc,
        stream,
        signalChannel,
      };

      pc.onconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
          stopShareSession().catch(() => null);
        }
      };

      setShareStatus("publishing");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);
      if (!pc.localDescription) throw new Error("Missing local description");

      setShareStatus("awaiting");
      await signalChannel.send({
        type: "broadcast",
        event: PEER_OFFER_EVENT,
        payload: {
          peerId,
          alias: shareAlias.trim() || "Guest share",
          offer: pc.localDescription,
          nonce,
          timestamp: Date.now(),
        } satisfies PeerOfferMessage,
      });
    } catch (err) {
      console.error("Failed to start screen share", err);
      setShareStatus("error");
      setShareError(err instanceof Error ? err.message : "Failed to start screen share");
      await stopShareSession();
    }
  }, [getVerifyKey, hostKey, shareAlias, stopShareSession]);

  const handleViewStream = useCallback(async () => {
    if (viewSessionRef.current) {
      await stopViewSession();
      return;
    }
    setViewError(null);
    setViewStatus("connecting");
    try {
      const pc = createPeerConnection();
      const stream = new MediaStream();
      viewSessionRef.current = {
        peerId: `viewer_${randomId()}`,
        pc,
        stream,
        signalChannel: supabase.channel(getSignalChannelName(hostKey), {
          config: { broadcast: { self: true } },
        }),
      };

      pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          if (viewVideoRef.current) {
            viewVideoRef.current.srcObject = event.streams[0];
          }
          if (viewSessionRef.current) {
            viewSessionRef.current.stream = event.streams[0];
          }
        } else if (event.track) {
          stream.addTrack(event.track);
          if (viewVideoRef.current) {
            viewVideoRef.current.srcObject = stream;
          }
        }
        setViewStatus("connected");
      };

      pc.onconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
          stopViewSession().catch(() => null);
        }
      };

      const signalChannel = viewSessionRef.current.signalChannel;
      const peerId = viewSessionRef.current.peerId;

      signalChannel.on("broadcast", { event: VIEW_ANSWER_EVENT }, async ({ payload }) => {
        const message = payload as { peerId: string; answer: RTCSessionDescriptionInit; signature: string };
        if (message.peerId !== peerId) return;
        const verifyKey = await getVerifyKey(hostKey);
        const isValid = await verifyHostSignature(
          verifyKey,
          { peerId: message.peerId, answer: message.answer },
          message.signature
        );
        if (!isValid) {
          setViewError("Host signature is invalid.");
          await stopViewSession();
          return;
        }
        const description =
          typeof RTCSessionDescription !== "undefined"
            ? new RTCSessionDescription(message.answer)
            : message.answer;
        await pc.setRemoteDescription(description);
      });

      await subscribeToRealtimeChannel(signalChannel);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);
      if (!pc.localDescription) throw new Error("Missing local description");

      await signalChannel.send({
        type: "broadcast",
        event: VIEW_OFFER_EVENT,
        payload: {
          peerId,
          offer: pc.localDescription,
          timestamp: Date.now(),
        },
      });
    } catch (err) {
      console.error("Failed to start viewing stream", err);
      setViewStatus("error");
      setViewError(err instanceof Error ? err.message : "Failed to start viewing stream");
      await stopViewSession();
    }
  }, [getVerifyKey, hostKey, stopViewSession]);

  useEffect(() => {
    return () => {
      stopShareSession();
      stopViewSession();
    };
  }, [stopShareSession, stopViewSession]);

  const isShareActive = shareStatus !== "idle" && shareStatus !== "error";
  const shareButtonDisabled = shareStatus === "prompting" || shareStatus === "publishing";
  const isViewActive = viewStatus !== "idle" && viewStatus !== "error";
  const viewButtonDisabled = viewStatus === "connecting";

  return (
    <div className="app">
      <div className="page">
        <div className="card">
          <header className="header">
            <div className="header-content">
              <p className="label">Channel host key</p>
              <code>{hostKey}</code>
            </div>
            <button className="btn btn-secondary" onClick={onBack}>
              Back to channels
            </button>
          </header>

          <section className="section">
            <div className="options-grid">
              <div className="option-card">
                <h3>Share screen</h3>
                <p>
                  Start a WebRTC session to push your screen into the host console. Your request is signed against the
                  host key so the host can trust it.
                </p>
                <div className="field">
                  <span className="field-label">Display name</span>
                  <input
                    className="field-input"
                    value={shareAlias}
                    onChange={(event) => setShareAlias(event.target.value)}
                    placeholder="Guest share"
                  />
                </div>
                {shareError && <p className="error">{shareError}</p>}
                <p className="muted">Status: {shareStatusCopy[shareStatus]}</p>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={handleShareScreen}
                  disabled={shareButtonDisabled}
                >
                  {isShareActive ? "Stop sharing" : "Share screen"}
                </button>
              </div>
              <div className="option-card">
                <h3>View stream</h3>
                <p>
                  Verify the host signature, connect, and watch the trusted broadcast feed. You only receive what the host
                  is streaming.
                </p>
                {viewError && <p className="error">{viewError}</p>}
                <p className="muted">Status: {viewStatusCopy[viewStatus]}</p>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={handleViewStream}
                  disabled={viewButtonDisabled}
                >
                  {isViewActive ? "Stop viewing" : "View stream"}
                </button>
                {isViewActive && (
                  <div className="video-player" style={{ marginTop: "1rem" }}>
                    <video
                      ref={viewVideoRef}
                      autoPlay
                      playsInline
                      muted
                    />
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

