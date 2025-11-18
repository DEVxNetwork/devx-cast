import "./index.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";

type StreamingPeer = {
  id: string;
  label: string;
  screenTitle: string;
  stream?: MediaStream | null;
  sessionId?: string;
};

type Channel = {
  id: string;
  hostKey: string;
  broadcastPeers: number;
  lastActive: number;
  streamingPeers: StreamingPeer[];
  activePeerId: string | null;
};

type HostStatusPayload = {
  hostId: string;
  hostKey: string;
  broadcastPeers: number;
  activePeerId: string | null;
  timestamp: number;
};

type HostStopPayload = { hostId: string };

type HostSession = {
  peerId: string;
  alias: string;
  nonce: string;
  pc: RTCPeerConnection;
  stream: MediaStream;
  channelId: string;
};

type ShareSession = {
  peerId: string;
  nonce: string;
  hostKey: string;
  pc: RTCPeerConnection;
  stream: MediaStream;
  signalChannel: RealtimeChannel;
};

type ShareStatus = "idle" | "prompting" | "publishing" | "awaiting" | "connected" | "error";

const shareStatusCopy: Record<ShareStatus, string> = {
  idle: "Not sharing",
  prompting: "Waiting for screen selection…",
  publishing: "Publishing offer…",
  awaiting: "Waiting for host to accept…",
  connected: "Streaming to host",
  error: "Share failed",
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

const HOST_DIRECTORY_CHANNEL = "host-directory";
const HOST_STATUS_EVENT = "host-status";
const HOST_STOP_EVENT = "host-stop";
const HOST_TIMEOUT_MS = 60_000;
const HOST_BROADCAST_INTERVAL_MS = 2_000;
const STALE_SWEEP_INTERVAL_MS = 5_000;

const randomId = () => Math.random().toString(36).slice(2, 10);
const sortByRecency = (a: Channel, b: Channel) => (a.lastActive < b.lastActive ? 1 : -1);
const upsertChannel = (channels: Channel[], updated: Channel) => {
  const filtered = channels.filter((channel) => channel.id !== updated.id);
  filtered.push(updated);
  return filtered.sort(sortByRecency);
};

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

export function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [hostedChannelId, setHostedChannelId] = useState<string | null>(null);
  const [isCreatingChannel, setIsCreatingChannel] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [shareStatus, setShareStatus] = useState<ShareStatus>("idle");
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareAlias, setShareAlias] = useState<string>("Guest share");

  const presenceChannelRef = useRef<RealtimeChannel | null>(null);
  const hostedChannelRef = useRef<Channel | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hostSessionsRef = useRef<Map<string, HostSession>>(new Map());
  const shareSessionRef = useRef<ShareSession | null>(null);
  const peerVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const hostKeyPairRef = useRef<HostKeyPair | null>(null);
  const hostSignalChannelRef = useRef<RealtimeChannel | null>(null);
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

  const broadcastLocalHostStatus = useCallback((channelOverride?: Channel) => {
    const presence = presenceChannelRef.current;
    const channel = channelOverride ?? hostedChannelRef.current;
    if (!presence || !channel) return;

    presence
      .send({
        type: "broadcast",
        event: HOST_STATUS_EVENT,
        payload: {
          hostId: channel.id,
          hostKey: channel.hostKey,
          broadcastPeers: channel.broadcastPeers,
          activePeerId: channel.activePeerId,
          timestamp: Date.now(),
        } satisfies HostStatusPayload,
      })
      .catch((err) => console.error("Failed to broadcast host heartbeat", err));
  }, []);

  const mutateChannel = useCallback((channelId: string, updater: (channel: Channel) => Channel) => {
    setChannels((prev) =>
      prev.map((channel) => {
        if (channel.id !== channelId) return channel;
        const nextChannel = updater(channel);
        if (hostedChannelRef.current && hostedChannelRef.current.id === nextChannel.id) {
          hostedChannelRef.current = nextChannel;
        }
        return nextChannel;
      })
    );
  }, []);

  const removeStreamingPeer = useCallback(
    (channelId: string, peerId: string) => {
      mutateChannel(channelId, (channel) => {
        const peers = channel.streamingPeers.filter((peer) => peer.id !== peerId);
        const nextActive = channel.activePeerId === peerId ? peers[0]?.id ?? null : channel.activePeerId;
        return { ...channel, streamingPeers: peers, activePeerId: nextActive };
      });
      if (hostedChannelRef.current && hostedChannelRef.current.id === channelId) {
        broadcastLocalHostStatus(hostedChannelRef.current);
      }
    },
    [broadcastLocalHostStatus, mutateChannel]
  );

  const selectedChannel = useMemo(
    () => channels.find((channel) => channel.id === selectedChannelId) ?? null,
    [channels, selectedChannelId]
  );
  const activePeer = selectedChannel
    ? selectedChannel.streamingPeers.find((peer) => peer.id === selectedChannel.activePeerId) ?? null
    : null;
  const isShareActive = shareStatus !== "idle" && shareStatus !== "error";
  const shareButtonDisabled = shareStatus === "prompting" || shareStatus === "publishing";

  const sendHostStop = useCallback((hostId: string) => {
    const presence = presenceChannelRef.current;
    if (!presence) return;
    presence
      .send({
        type: "broadcast",
        event: HOST_STOP_EVENT,
        payload: { hostId } satisfies HostStopPayload,
      })
      .catch((err) => console.error("Failed to send host stop", err));
  }, []);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const closeHostSession = useCallback(
    (peerId: string) => {
      const session = hostSessionsRef.current.get(peerId);
      if (!session) return;
      session.stream.getTracks().forEach((track) => track.stop());
      session.pc.ontrack = null;
      session.pc.onconnectionstatechange = null;
      session.pc.close();
      hostSessionsRef.current.delete(peerId);
      removeStreamingPeer(session.channelId, session.peerId);
    },
    [removeStreamingPeer]
  );

  const teardownHostSessions = useCallback(() => {
    Array.from(hostSessionsRef.current.keys()).forEach((peerId) => closeHostSession(peerId));
  }, [closeHostSession]);

  const attachStreamToPeer = useCallback(
    (channelId: string, peerId: string, stream: MediaStream, label: string, sessionId: string) => {
      mutateChannel(channelId, (channel) => {
        const peers = channel.streamingPeers.filter((item) => item.id !== peerId);
        peers.push({
          id: peerId,
          label,
          screenTitle: "Live screen share",
          stream,
          sessionId,
        });
        return {
          ...channel,
          streamingPeers: peers,
          activePeerId: channel.activePeerId ?? peerId,
        };
      });
      if (hostedChannelRef.current && hostedChannelRef.current.id === channelId) {
        broadcastLocalHostStatus(hostedChannelRef.current);
      }
    },
    [broadcastLocalHostStatus, mutateChannel]
  );

  const handlePeerOffer = useCallback(
    async (payload: PeerOfferMessage) => {
      const channel = hostedChannelRef.current;
      const keyPair = hostKeyPairRef.current;
      const signalChannel = hostSignalChannelRef.current;
      if (!channel || !keyPair || !signalChannel) return;

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
          channelId: channel.id,
        });

        pc.ontrack = (event) => {
          if (event.streams && event.streams[0]) {
            attachStreamToPeer(channel.id, peerId, event.streams[0], payload.alias ?? "Guest share", peerId);
          } else {
            stream.addTrack(event.track);
            attachStreamToPeer(channel.id, peerId, stream, payload.alias ?? "Guest share", peerId);
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
    [attachStreamToPeer, closeHostSession]
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
      await subscribeToRealtimeChannel(signalChannel);
      hostSignalChannelRef.current = signalChannel;
    },
    [handlePeerOffer]
  );

  const stopHostSignalChannel = useCallback(async () => {
    if (hostSignalChannelRef.current) {
      await hostSignalChannelRef.current.unsubscribe().catch(() => null);
      hostSignalChannelRef.current = null;
    }
  }, []);

  const stopHosting = useCallback(() => {
    const current = hostedChannelRef.current;
    if (!current) return;
    sendHostStop(current.id);
    hostedChannelRef.current = null;
    setHostedChannelId(null);
    hostKeyPairRef.current = null;
    if (hostSignalChannelRef.current) {
      hostSignalChannelRef.current
        .send({
          type: "broadcast",
          event: HOST_TERMINATE_EVENT,
          payload: { timestamp: Date.now() },
        })
        .catch(() => null);
    }
    stopHostSignalChannel().catch(() => null);
    stopHeartbeat();
    teardownHostSessions();
    setChannels((prev) => prev.filter((channel) => channel.id !== current.id));
  }, [sendHostStop, stopHeartbeat, stopHostSignalChannel, teardownHostSessions]);

  const handleHostStatus = useCallback((payload: HostStatusPayload) => {
    setChannels((prev) => {
      const existing = prev.find((channel) => channel.id === payload.hostId);
      const merged: Channel = {
        id: payload.hostId,
        hostKey: payload.hostKey,
        broadcastPeers: payload.broadcastPeers ?? existing?.broadcastPeers ?? 0,
        lastActive: payload.timestamp,
        streamingPeers:
          hostedChannelRef.current && hostedChannelRef.current.id === payload.hostId
            ? hostedChannelRef.current.streamingPeers
            : existing?.streamingPeers ?? [],
        activePeerId:
          hostedChannelRef.current && hostedChannelRef.current.id === payload.hostId
            ? hostedChannelRef.current.activePeerId
            : payload.activePeerId ?? existing?.activePeerId ?? null,
      };
      return upsertChannel(prev, merged);
    });
  }, []);

  const handleHostStop = useCallback((payload: HostStopPayload) => {
    setChannels((prev) => prev.filter((channel) => channel.id !== payload.hostId));
    if (hostedChannelRef.current && hostedChannelRef.current.id === payload.hostId) {
      hostedChannelRef.current = null;
      setHostedChannelId(null);
      stopHeartbeat();
    }
  }, [stopHeartbeat]);

  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    broadcastLocalHostStatus();
    heartbeatRef.current = setInterval(() => {
      broadcastLocalHostStatus();
    }, HOST_BROADCAST_INTERVAL_MS);
  }, [broadcastLocalHostStatus, stopHeartbeat]);

  useEffect(() => {
    const channel = supabase.channel(HOST_DIRECTORY_CHANNEL, {
      config: { broadcast: { self: true } },
    });
    presenceChannelRef.current = channel;

    channel
      .on("broadcast", { event: HOST_STATUS_EVENT }, ({ payload }) => {
        handleHostStatus(payload as HostStatusPayload);
      })
      .on("broadcast", { event: HOST_STOP_EVENT }, ({ payload }) => {
        handleHostStop(payload as HostStopPayload);
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED" && hostedChannelRef.current) {
          broadcastLocalHostStatus();
        }
      });

    return () => {
      channel.unsubscribe();
      presenceChannelRef.current = null;
    };
  }, [broadcastLocalHostStatus, handleHostStatus, handleHostStop]);

  useEffect(() => {
    const interval = setInterval(() => {
      setChannels((prev) => {
        const cutoff = Date.now() - HOST_TIMEOUT_MS;
        return prev.filter(
          (channel) =>
            channel.lastActive >= cutoff ||
            (hostedChannelRef.current && hostedChannelRef.current.id === channel.id)
        );
      });
    }, STALE_SWEEP_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (channels.length === 0) {
      if (selectedChannelId !== null) {
        setSelectedChannelId(null);
      }
      return;
    }

    const firstChannel = channels[0];
    if (!firstChannel) return;

    if (!selectedChannelId || !channels.some((channel) => channel.id === selectedChannelId)) {
      setSelectedChannelId(firstChannel.id);
    }
  }, [channels, selectedChannelId]);

  useEffect(() => {
    return () => {
      stopHosting();
    };
  }, [stopHosting]);

  useEffect(() => {
    return () => {
      stopHostSignalChannel().catch(() => null);
    };
  }, [stopHostSignalChannel]);

  useEffect(() => {
    channels.forEach((channel) => {
      channel.streamingPeers.forEach((peer) => {
        const video = peerVideoRefs.current.get(peer.id);
        if (video && peer.stream && video.srcObject !== peer.stream) {
          video.srcObject = peer.stream;
        }
      });
    });
  }, [channels]);

  const handleAddChannel = useCallback(async () => {
    if (isCreatingChannel) return;
    setIsCreatingChannel(true);
    setError(null);
    try {
      if (typeof window === "undefined" || !window.crypto?.subtle) {
        throw new Error("Web Crypto API is not available in this environment.");
      }
      if (hostedChannelRef.current) {
        stopHosting();
      }

      const keyPair = await generateHostKeyPair();
      hostKeyPairRef.current = keyPair;

      const nextChannel: Channel = {
        id: `channel_${randomId()}`,
        hostKey: keyPair.publicKeyString,
        broadcastPeers: Math.floor(Math.random() * 240) + 16,
        lastActive: Date.now(),
        streamingPeers: [],
        activePeerId: null,
      };

      hostedChannelRef.current = nextChannel;
      setHostedChannelId(nextChannel.id);
      setChannels((prev) => upsertChannel(prev, nextChannel));
      setSelectedChannelId(nextChannel.id);

      await startHostSignalChannel(keyPair.publicKeyString);
      broadcastLocalHostStatus(nextChannel);
      startHeartbeat();
    } catch (err) {
      console.error("Failed to create channel", err);
      setError(err instanceof Error ? err.message : "Failed to create channel");
    } finally {
      setIsCreatingChannel(false);
    }
  }, [broadcastLocalHostStatus, isCreatingChannel, startHeartbeat, startHostSignalChannel, stopHosting]);

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

  const handleShareScreen = useCallback(async (channelOverride?: Channel) => {
    const targetChannel = channelOverride ?? selectedChannel;
    if (shareSessionRef.current) {
      await stopShareSession();
      return;
    }
    if (!targetChannel) {
      setShareError("Select a channel to share your screen.");
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

      const hostKey = targetChannel.hostKey;
      const signalChannel = supabase.channel(getSignalChannelName(hostKey), { config: { broadcast: { self: true } } });
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
          typeof RTCSessionDescription !== "undefined" ? new RTCSessionDescription(message.answer) : message.answer;
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
  }, [getVerifyKey, selectedChannel, shareAlias, stopShareSession]);

  useEffect(() => {
    return () => {
      stopShareSession();
    };
  }, [stopShareSession]);

  const handleHighlightPeer = (peerId: string) => {
    if (!selectedChannel) return;
    setChannels((prev) =>
      prev.map((channel) => {
        if (channel.id !== selectedChannel.id) return channel;
        const updated = { ...channel, activePeerId: peerId };
        if (hostedChannelRef.current && hostedChannelRef.current.id === channel.id) {
          hostedChannelRef.current = updated;
          broadcastLocalHostStatus(updated);
        }
        return updated;
      })
    );
  };

  return (
    <div className="app-shell">
      <aside className="channel-panel">
        <div className="channel-panel-header">
          <div>
            <p className="label">Active channels</p>
            <strong>{channels.length}</strong>
          </div>
          <button className="primary-button" onClick={handleAddChannel} disabled={isCreatingChannel}>
            {isCreatingChannel ? "Starting…" : "Add channel"}
        </button>
        </div>
        <div className="channel-list">
          {channels.length === 0 && <p className="muted">Waiting for hosts to appear…</p>}
          {channels.map((channel) => {
            const isSelected = channel.id === selectedChannelId;
            return (
              <button
                key={channel.id}
                className={`channel-item ${isSelected ? "selected" : ""}`}
                onClick={() => {
                  setSelectedChannelId(channel.id);
                  if (!hostedChannelId && shareStatus === "idle") {
                    void handleShareScreen(channel);
                  }
                }}
              >
                <p>Host public key</p>
                <code>{channel.hostKey}</code>
                <span>{channel.activePeerId ? "Broadcasting" : "Waiting"}</span>
        </button>
            );
          })}
        </div>
        {error && <p className="error-text">{error}</p>}
      </aside>

      <main className="console-panel">
        {selectedChannel ? (
          <>
            <header className="console-header">
              <div>
                <p className="label">Channel host key</p>
                <code>{selectedChannel.hostKey}</code>
              </div>
              <p>
                The channel is the host&apos;s public key. Every peer verifies this key when they establish a WebRTC
                connection with signed messages.
              </p>
            </header>

            <section className="console-section broadcast-section">
              <div className="broadcast-video" data-empty={!activePeer}>
                {activePeer ? (
                  <>
                    <p className="broadcast-label">{activePeer.label}</p>
                    <span>{activePeer.screenTitle}</span>
                  </>
                ) : (
                  <p>No active stream selected</p>
                )}
              </div>
              <div className="broadcast-meta">
                <div>
                  <p className="label">Broadcast peer count</p>
                  <strong>{selectedChannel.broadcastPeers}</strong>
          </div>
                <div>
                  <p className="label">Active streaming peer</p>
                  <span>{activePeer ? activePeer.label : "None"}</span>
          </div>
        </div>
      </section>

            <section className="console-section peer-options">
              <article>
                <h3>Share screen</h3>
                <p>
                  Start a WebRTC session to push your screen into the host console. Your request is signed against the
                  host key so the host can trust it.
                </p>
                <label className="field">
                  <span>Display name</span>
                  <input value={shareAlias} onChange={(event) => setShareAlias(event.target.value)} placeholder="Guest share" />
                </label>
                {shareError && <p className="error-text">{shareError}</p>}
                <p className="muted">Status: {shareStatusCopy[shareStatus]}</p>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    void handleShareScreen();
                  }}
                  disabled={shareButtonDisabled}
                >
                  {isShareActive ? "Stop sharing" : "Share screen"}
                </button>
              </article>
              <article>
                <h3>View host stream</h3>
                <p>
                  Verify the host signature, connect, and watch the trusted broadcast feed. You only receive what the
                  host is streaming.
                </p>
                <button className="secondary-button" type="button">
                  View host stream
                </button>
              </article>
            </section>

            <section className="console-section streaming-section">
              <div className="section-heading">
                <div>
                  <p className="label">Streaming peers</p>
                  <p>Only peers actively sharing are shown here.</p>
                </div>
                <span>{selectedChannel.streamingPeers.length}</span>
              </div>

              {selectedChannel.streamingPeers.length === 0 ? (
                <p className="muted">No peers are streaming to this channel.</p>
              ) : (
                <div className="peer-grid">
                  {selectedChannel.streamingPeers.map((peer) => {
                    const isActive = selectedChannel.activePeerId === peer.id;
                    return (
                      <article key={peer.id} className={`peer-card ${isActive ? "active" : ""}`}>
                        <div className="peer-video">
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
                        <div className="peer-details">
                          <strong>{peer.label}</strong>
                          <p>{peer.screenTitle}</p>
                        </div>
                        <button
                          className="primary-button"
                          type="button"
                          onClick={() => handleHighlightPeer(peer.id)}
                        >
                          {isActive ? "Broadcasting" : "Switch broadcast"}
                        </button>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        ) : (
          <div className="empty-panel">
            <p>Select a channel or create one to manage its broadcast stream.</p>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
