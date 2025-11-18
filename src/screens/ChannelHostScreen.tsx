import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

type StreamingPeer = {
  id: string;
  label: string;
  screenTitle: string;
  stream?: MediaStream | null;
  sessionId?: string;
};

type HostStatusPayload = {
  hostId: string;
  hostKey: string;
  broadcastPeers: number;
  activePeerId: string | null;
  timestamp: number;
};

type HostSession = {
  peerId: string;
  alias: string;
  nonce: string;
  pc: RTCPeerConnection;
  stream: MediaStream;
  channelId: string;
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

const generateHostKeyPair = async (): Promise<HostKeyPair> => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign", "verify"]
  );
  const publicBuffer = await crypto.subtle.exportKey("spki", keyPair.publicKey);
  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    publicKeyString: arrayBufferToBase64Url(publicBuffer),
  };
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

const signPayload = (privateKey: CryptoKey, payload: object) =>
  crypto.subtle
    .sign(
      {
        name: "ECDSA",
        hash: "SHA-256",
      },
      privateKey,
      encodePayload(payload)
    )
    .then(arrayBufferToBase64Url);

const HOST_DIRECTORY_CHANNEL = "host-directory";
const HOST_STATUS_EVENT = "host-status";
const HOST_STOP_EVENT = "host-stop";
const HOST_BROADCAST_INTERVAL_MS = 2_000;

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

type ChannelHostScreenProps = {
  channelId: string;
  onBack: () => void;
};

export function ChannelHostScreen({ channelId, onBack }: ChannelHostScreenProps) {
  const [streamingPeers, setStreamingPeers] = useState<StreamingPeer[]>([]);
  const [activePeerId, setActivePeerId] = useState<string | null>(null);
  const [broadcastPeers, setBroadcastPeers] = useState<number>(0);

  const presenceChannelRef = useRef<RealtimeChannel | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hostSessionsRef = useRef<Map<string, HostSession>>(new Map());
  const peerVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const hostVideoRef = useRef<HTMLVideoElement | null>(null);
  const hostKeyPairRef = useRef<HostKeyPair | null>(null);
  const hostSignalChannelRef = useRef<RealtimeChannel | null>(null);
  const viewSessionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());

  const activePeer = useMemo(
    () => streamingPeers.find((peer) => peer.id === activePeerId) ?? null,
    [streamingPeers, activePeerId]
  );

  const broadcastLocalHostStatus = useCallback(() => {
    const presence = presenceChannelRef.current;
    if (!presence || !hostKeyPairRef.current) return;

    presence
      .send({
        type: "broadcast",
        event: HOST_STATUS_EVENT,
        payload: {
          hostId: channelId,
          hostKey: hostKeyPairRef.current.publicKeyString,
          broadcastPeers,
          activePeerId,
          timestamp: Date.now(),
        } satisfies HostStatusPayload,
      })
      .catch((err) => console.error("Failed to broadcast host heartbeat", err));
  }, [channelId, broadcastPeers, activePeerId]);

  const removeStreamingPeer = useCallback(
    (peerId: string) => {
      setStreamingPeers((prev) => {
        const peers = prev.filter((peer) => peer.id !== peerId);
        return peers;
      });
      setActivePeerId((current) => {
        if (current === peerId) {
          return streamingPeers.find((peer) => peer.id !== peerId)?.id ?? null;
        }
        return current;
      });
    },
    [streamingPeers]
  );

  const closeHostSession = useCallback(
    (peerId: string) => {
      const session = hostSessionsRef.current.get(peerId);
      if (!session) return;
      session.stream.getTracks().forEach((track) => track.stop());
      session.pc.ontrack = null;
      session.pc.onconnectionstatechange = null;
      session.pc.close();
      hostSessionsRef.current.delete(peerId);
      removeStreamingPeer(session.peerId);
    },
    [removeStreamingPeer]
  );

  const attachStreamToPeer = useCallback(
    (peerId: string, stream: MediaStream, label: string, sessionId: string) => {
      setStreamingPeers((prev) => {
        const peers = prev.filter((item) => item.id !== peerId);
        peers.push({
          id: peerId,
          label,
          screenTitle: "Live screen share",
          stream,
          sessionId,
        });
        return peers;
      });
      setActivePeerId((current) => current ?? peerId);
    },
    []
  );

  const handlePeerOffer = useCallback(
    async (payload: PeerOfferMessage) => {
      const keyPair = hostKeyPairRef.current;
      const signalChannel = hostSignalChannelRef.current;
      if (!keyPair || !signalChannel) return;

      const peerId = payload.peerId;
      if (hostSessionsRef.current.has(peerId)) {
        closeHostSession(peerId);
      }

      try {
        const pc = createPeerConnection();
        const stream = new MediaStream();
        hostSessionsRef.current.set(peerId, {
          peerId,
          alias: payload.alias || "Guest share",
          nonce: payload.nonce,
          pc,
          stream,
          channelId,
        });

        pc.ontrack = (event) => {
          if (event.streams && event.streams[0]) {
            attachStreamToPeer(peerId, event.streams[0], payload.alias ?? "Guest share", peerId);
          } else {
            stream.addTrack(event.track);
            attachStreamToPeer(peerId, stream, payload.alias ?? "Guest share", peerId);
          }
        };

        pc.onconnectionstatechange = () => {
          if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
            closeHostSession(peerId);
          }
        };

        await pc.setRemoteDescription(payload.offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitForIceGathering(pc);
        if (!pc.localDescription) throw new Error("Missing local description");

        const signedPayload = {
          peerId,
          nonce: payload.nonce,
          answer: pc.localDescription,
        };
        const signature = await signPayload(keyPair.privateKey, signedPayload);

        await signalChannel.send({
          type: "broadcast",
          event: HOST_ANSWER_EVENT,
          payload: {
            ...signedPayload,
            signature,
            timestamp: Date.now(),
          } satisfies HostAnswerMessage,
        });
      } catch (err) {
        console.error("Failed to process peer offer", err);
        closeHostSession(peerId);
      }
    },
    [attachStreamToPeer, closeHostSession, channelId]
  );

  const handleViewOffer = useCallback(
    async (payload: { peerId: string; offer: RTCSessionDescriptionInit }) => {
      const keyPair = hostKeyPairRef.current;
      const signalChannel = hostSignalChannelRef.current;
      if (!keyPair || !signalChannel || !activePeer) return;

      const viewerId = payload.peerId;
      if (viewSessionsRef.current.has(viewerId)) {
        viewSessionsRef.current.get(viewerId)?.close();
        viewSessionsRef.current.delete(viewerId);
      }

      try {
        const pc = createPeerConnection();
        viewSessionsRef.current.set(viewerId, pc);

        // Add tracks from active peer stream
        if (activePeer.stream) {
          activePeer.stream.getTracks().forEach((track) => {
            pc.addTrack(track, activePeer.stream!);
          });
        }

        pc.onconnectionstatechange = () => {
          if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
            viewSessionsRef.current.delete(viewerId);
          }
        };

        await pc.setRemoteDescription(payload.offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitForIceGathering(pc);
        if (!pc.localDescription) throw new Error("Missing local description");

        const signedPayload = {
          peerId: viewerId,
          answer: pc.localDescription,
        };
        const signature = await signPayload(keyPair.privateKey, signedPayload);

        await signalChannel.send({
          type: "broadcast",
          event: VIEW_ANSWER_EVENT,
          payload: {
            ...signedPayload,
            signature,
            timestamp: Date.now(),
          },
        });
      } catch (err) {
        console.error("Failed to process view offer", err);
        viewSessionsRef.current.delete(viewerId);
      }
    },
    [activePeer]
  );

  const startHostSignalChannel = useCallback(
    async (hostKey: string) => {
      if (hostSignalChannelRef.current) {
        await hostSignalChannelRef.current.unsubscribe().catch(() => null);
        hostSignalChannelRef.current = null;
      }
      const channelName = getSignalChannelName(hostKey);
      const signalChannel = supabase.channel(channelName, { config: { broadcast: { self: false } } });
      signalChannel.on("broadcast", { event: PEER_OFFER_EVENT }, ({ payload }) => {
        handlePeerOffer(payload as PeerOfferMessage);
      });
      signalChannel.on("broadcast", { event: VIEW_OFFER_EVENT }, ({ payload }) => {
        handleViewOffer(payload as { peerId: string; offer: RTCSessionDescriptionInit });
      });
      await subscribeToRealtimeChannel(signalChannel);
      hostSignalChannelRef.current = signalChannel;
    },
    [handlePeerOffer, handleViewOffer]
  );

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    broadcastLocalHostStatus();
    heartbeatRef.current = setInterval(() => {
      broadcastLocalHostStatus();
    }, HOST_BROADCAST_INTERVAL_MS);
  }, [broadcastLocalHostStatus, stopHeartbeat]);

  const teardownHostSessions = useCallback(() => {
    Array.from(hostSessionsRef.current.keys()).forEach((peerId) => closeHostSession(peerId));
    Array.from(viewSessionsRef.current.values()).forEach((pc) => pc.close());
    viewSessionsRef.current.clear();
  }, [closeHostSession]);

  const handleHighlightPeer = useCallback((peerId: string) => {
    setActivePeerId(peerId);
  }, []);

  useEffect(() => {
    const initHost = async () => {
      try {
        if (typeof window === "undefined" || !window.crypto?.subtle) {
          throw new Error("Web Crypto API is not available in this environment.");
        }

        const keyPair = await generateHostKeyPair();
        hostKeyPairRef.current = keyPair;
        await startHostSignalChannel(keyPair.publicKeyString);
        broadcastLocalHostStatus();
        startHeartbeat();
      } catch (err) {
        console.error("Failed to initialize host", err);
      }
    };

    initHost();

    return () => {
      stopHeartbeat();
      teardownHostSessions();
      if (hostSignalChannelRef.current) {
        hostSignalChannelRef.current.unsubscribe().catch(() => null);
      }
    };
  }, [broadcastLocalHostStatus, startHeartbeat, startHostSignalChannel, stopHeartbeat, teardownHostSessions]);

  useEffect(() => {
    const channel = supabase.channel(HOST_DIRECTORY_CHANNEL, {
      config: { broadcast: { self: true } },
    });
    presenceChannelRef.current = channel;
    channel.subscribe();
    return () => {
      channel.unsubscribe();
      presenceChannelRef.current = null;
    };
  }, []);

  useEffect(() => {
    streamingPeers.forEach((peer) => {
      const video = peerVideoRefs.current.get(peer.id);
      if (video && peer.stream && video.srcObject !== peer.stream) {
        video.srcObject = peer.stream;
      }
    });
  }, [streamingPeers]);

  useEffect(() => {
    if (hostVideoRef.current && activePeer?.stream) {
      hostVideoRef.current.srcObject = activePeer.stream;
    } else if (hostVideoRef.current) {
      hostVideoRef.current.srcObject = null;
    }
    broadcastLocalHostStatus();
  }, [activePeer, broadcastLocalHostStatus]);

  useEffect(() => {
    // Update viewer streams when active peer changes
    if (activePeer?.stream) {
      viewSessionsRef.current.forEach((pc) => {
        // Remove old tracks
        pc.getSenders().forEach((sender) => {
          if (sender.track) {
            pc.removeTrack(sender);
          }
        });
        // Add new tracks from active peer
        activePeer.stream.getTracks().forEach((track) => {
          pc.addTrack(track, activePeer.stream!);
        });
      });
    }
  }, [activePeer]);

  return (
    <div className="app">
      <div className="page">
        <div className="card">
          <header className="header">
            <div className="header-content">
              <p className="label">Host channel</p>
              <code>{hostKeyPairRef.current?.publicKeyString ?? "Initializing…"}</code>
            </div>
            <button className="btn btn-secondary" onClick={onBack}>
              Stop hosting
            </button>
          </header>

          <section className="section">
            <div className="broadcast-player" data-empty={!activePeer}>
              {activePeer ? (
                <>
                  <video
                    ref={hostVideoRef}
                    autoPlay
                    playsInline
                    muted
                  />
                  <div className="broadcast-info">
                    <p className="broadcast-title">{activePeer.label}</p>
                    <p className="broadcast-subtitle">{activePeer.screenTitle}</p>
                  </div>
                </>
              ) : (
                <p>No active stream selected</p>
              )}
            </div>
            <div className="stats">
              <div className="stat">
                <p className="label stat-label">Broadcast peer count</p>
                <span className="stat-value">{broadcastPeers}</span>
              </div>
              <div className="stat">
                <p className="label stat-label">Active streaming peer</p>
                <span className="stat-value" style={{ fontSize: "1rem", fontWeight: "normal" }}>
                  {activePeer ? activePeer.label : "None"}
                </span>
              </div>
            </div>
          </section>

          <section className="section">
            <div className="section-header">
              <div className="section-title">
                <p className="label">Streaming peers</p>
                <p className="muted" style={{ fontSize: "0.875rem", margin: 0 }}>
                  Only peers actively sharing are shown here.
                </p>
              </div>
              <span className="section-count">{streamingPeers.length}</span>
            </div>

            {streamingPeers.length === 0 ? (
              <p className="muted">No peers are streaming to this channel.</p>
            ) : (
              <div className="peer-grid">
                {streamingPeers.map((peer) => {
                  const isActive = activePeerId === peer.id;
                  return (
                    <div key={peer.id} className={`peer-card ${isActive ? "active" : ""}`}>
                      <div className="peer-video-container">
                        {peer.stream ? (
                          <video
                            ref={(el) => {
                              if (!el) {
                                peerVideoRefs.current.delete(peer.id);
                                return;
                              }
                              peerVideoRefs.current.set(peer.id, el);
                              if (peer.stream && el.srcObject !== peer.stream) {
                                el.srcObject = peer.stream;
                              }
                            }}
                            autoPlay
                            playsInline
                            muted
                          />
                        ) : (
                          <span>{peer.label}</span>
                        )}
                      </div>
                      <div className="peer-info">
                        <span className="peer-name">{peer.label}</span>
                        <p className="peer-description">{peer.screenTitle}</p>
                      </div>
                      <button
                        className="btn btn-primary"
                        type="button"
                        onClick={() => handleHighlightPeer(peer.id)}
                      >
                        {isActive ? "Broadcasting" : "Switch broadcast"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

