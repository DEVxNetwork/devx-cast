import { useEffect, useCallback } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import {
  useStreamingPeers,
  useActivePeerId,
  useBroadcastPeers,
  useHostKeyPair,
  useActivePeer,
} from "../store/channelStoreHelpers";
import { useChannelStore } from "../store/channelStore";
import {
  hostSessionsRef,
  viewSessionsRef,
  hostKeyPairRef,
  hostSignalChannelRef,
  presenceChannelRef,
  heartbeatRef,
  peerVideoRefs,
} from "../store/webrtcRefs";
import { ScreenHeader } from "../components/ScreenHeader";
import { BroadcastPlayer } from "../components/BroadcastPlayer";
import { StatsDisplay } from "../components/StatsDisplay";
import { StreamingPeersSection } from "../components/StreamingPeersSection";
import { PeerCard } from "../components/PeerCard";
import { EmptyState } from "../components/EmptyState";

type HostStatusPayload = {
  hostId: string;
  hostKey: string;
  broadcastPeers: number;
  activePeerId: string | null;
  timestamp: number;
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
    channel.subscribe((status: string) => {
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
  const streamingPeers = useStreamingPeers();
  const activePeerId = useActivePeerId();
  const broadcastPeers = useBroadcastPeers();
  const hostKeyPair = useHostKeyPair();
  const activePeer = useActivePeer();

  // Helper functions that access store via getState() to avoid closures
  const broadcastLocalHostStatus = () => {
    const presence = presenceChannelRef.current;
    const currentState = useChannelStore.getState();
    if (!presence || !currentState.hostKeyPair) return;

    presence
      .send({
        type: "broadcast",
        event: HOST_STATUS_EVENT,
        payload: {
          hostId: channelId,
          hostKey: currentState.hostKeyPair.publicKeyString,
          broadcastPeers: currentState.broadcastPeers,
          activePeerId: currentState.activePeerId,
          timestamp: Date.now(),
        } satisfies HostStatusPayload,
      })
      .catch((err) => console.error("Failed to broadcast host heartbeat", err));
  };

  const removeStreamingPeerCallback = (peerId: string) => {
    const { removeStreamingPeer, streamingPeers, activePeerId, setActivePeerId } = useChannelStore.getState();
    removeStreamingPeer(peerId);
    if (activePeerId === peerId) {
      const remainingPeers = streamingPeers.filter((p) => p.id !== peerId);
      setActivePeerId(remainingPeers[0]?.id ?? null);
    }
  };

  const closeHostSession = (peerId: string) => {
    const session = hostSessionsRef.get(peerId);
    if (!session) return;
    session.stream.getTracks().forEach((track) => track.stop());
    session.pc.ontrack = null;
    session.pc.onconnectionstatechange = null;
    session.pc.close();
    hostSessionsRef.delete(peerId);
    removeStreamingPeerCallback(session.peerId);
  };

  const attachStreamToPeer = (peerId: string, stream: MediaStream, label: string, sessionId: string) => {
    const { updateStreamingPeer, activePeerId, setActivePeerId } = useChannelStore.getState();
    updateStreamingPeer(peerId, {
      label,
      screenTitle: "Live screen share",
      stream,
      sessionId,
    });
    if (!activePeerId) {
      setActivePeerId(peerId);
    }
  };

  const handlePeerOffer = async (payload: PeerOfferMessage) => {
    const keyPair = hostKeyPairRef.current;
    const signalChannel = hostSignalChannelRef.current;
    if (!keyPair || !signalChannel) {
      console.warn("Host not ready to accept peer offer", { keyPair: !!keyPair, signalChannel: !!signalChannel });
      return;
    }

    const peerId = payload.peerId;
    const alias = payload.alias || "Guest share";
    console.log("Host received peer offer", { peerId, alias });

    // Close existing session if peer reconnects
    if (hostSessionsRef.has(peerId)) {
      console.log("Closing existing session for peer", peerId);
      closeHostSession(peerId);
    }

    // Add peer to list immediately (before tracks arrive) so it shows up in UI
    const { streamingPeers, addStreamingPeer } = useChannelStore.getState();
    const existing = streamingPeers.find((p) => p.id === peerId);
    if (!existing) {
      addStreamingPeer({
        id: peerId,
        label: alias,
        screenTitle: "Connecting...",
        stream: null,
        sessionId: peerId,
      });
    }

    try {
      const pc = createPeerConnection();
      const stream = new MediaStream();

      // Store session before setting up handlers
      hostSessionsRef.set(peerId, {
        peerId,
        alias,
        nonce: payload.nonce,
        pc,
        stream,
        channelId,
      });

      // Handle incoming tracks from peer
      pc.ontrack = (event) => {
        console.log("Host received track from peer", { peerId, trackId: event.track.id });
        if (event.streams && event.streams[0]) {
          attachStreamToPeer(peerId, event.streams[0], alias, peerId);
        } else if (event.track) {
          stream.addTrack(event.track);
          attachStreamToPeer(peerId, stream, alias, peerId);
        }
      };

      // Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log("Host ICE candidate", { peerId, candidate: event.candidate.candidate });
        } else {
          console.log("Host ICE candidate gathering complete", { peerId });
        }
      };

      // Handle ICE connection state changes
      pc.oniceconnectionstatechange = () => {
        const iceState = pc.iceConnectionState;
        console.log("Host ICE connection state changed", { peerId, iceConnectionState: iceState });
        if (iceState === "failed") {
          console.log("Host ICE connection failed - closing session", { peerId });
          closeHostSession(peerId);
        }
      };

      // Handle connection state changes
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.log("Host peer connection state changed", { peerId, state, iceConnectionState: pc.iceConnectionState, iceGatheringState: pc.iceGatheringState });
        if (state === "failed" || state === "closed") {
          console.log("Host peer connection closed", { peerId, state, iceConnectionState: pc.iceConnectionState });
          closeHostSession(peerId);
        } else if (state === "connected") {
          console.log("Host peer connection established", { peerId, iceConnectionState: pc.iceConnectionState });
        }
      };

      // Set remote description FIRST (before tracks arrive)
      console.log("Host setting remote description", { peerId });
      await pc.setRemoteDescription(payload.offer);
      console.log("Host set remote description", { peerId });

      // Create answer
      console.log("Host creating answer", { peerId });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      console.log("Host created answer", { peerId });

      // Wait for ICE gathering to complete
      console.log("Host waiting for ICE gathering", { peerId });
      await waitForIceGathering(pc);
      if (!pc.localDescription) {
        throw new Error("Missing local description after ICE gathering");
      }
      console.log("Host ICE gathering complete", { peerId });

      // Sign and send answer back to peer
      const signedPayload = {
        peerId,
        nonce: payload.nonce,
        answer: pc.localDescription,
      };
      console.log("Host signing answer", { peerId });
      const signature = await signPayload(keyPair.privateKey, signedPayload);

      console.log("Host sending answer to peer", { peerId, signalChannel: !!signalChannel });
      await signalChannel.send({
        type: "broadcast",
        event: HOST_ANSWER_EVENT,
        payload: {
          ...signedPayload,
          signature,
          timestamp: Date.now(),
        } satisfies HostAnswerMessage,
      });

      console.log("Host sent answer to peer", { peerId });

      // Broadcast updated host status with new peer count
      broadcastLocalHostStatus();
    } catch (err) {
      console.error("Failed to process peer offer", { peerId, error: err });
      closeHostSession(peerId);
    }
  };

  const handleViewOffer = async (payload: { peerId: string; offer: RTCSessionDescriptionInit }) => {
    const keyPair = hostKeyPairRef.current;
    const signalChannel = hostSignalChannelRef.current;
    const currentState = useChannelStore.getState();
    const activePeer = currentState.activePeerId
      ? currentState.streamingPeers.find((p) => p.id === currentState.activePeerId)
      : null;
    if (!keyPair || !signalChannel || !activePeer) return;

    const viewerId = payload.peerId;
    if (viewSessionsRef.has(viewerId)) {
      viewSessionsRef.get(viewerId)?.close();
      viewSessionsRef.delete(viewerId);
    }

    try {
      const pc = createPeerConnection();
      viewSessionsRef.set(viewerId, pc);

      // Add tracks from active peer stream
      if (activePeer.stream) {
        activePeer.stream.getTracks().forEach((track) => {
          pc.addTrack(track, activePeer.stream!);
        });
      }

      pc.onconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
          viewSessionsRef.delete(viewerId);
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
      viewSessionsRef.delete(viewerId);
    }
  };

  const startHostSignalChannel = async (hostKey: string) => {
    if (hostSignalChannelRef.current) {
      await hostSignalChannelRef.current.unsubscribe().catch(() => null);
      hostSignalChannelRef.current = null;
    }
    const channelName = getSignalChannelName(hostKey);
    console.log("Host starting signal channel", { channelName });
    const signalChannel = supabase.channel(channelName, { config: { broadcast: { self: false } } });

    // Set up event listeners BEFORE subscribing
    signalChannel.on("broadcast", { event: PEER_OFFER_EVENT }, ({ payload }) => {
      console.log("Host received PEER_OFFER_EVENT", payload);
      handlePeerOffer(payload as PeerOfferMessage);
    });
    signalChannel.on("broadcast", { event: VIEW_OFFER_EVENT }, ({ payload }) => {
      console.log("Host received VIEW_OFFER_EVENT", payload);
      handleViewOffer(payload as { peerId: string; offer: RTCSessionDescriptionInit });
    });

    // Subscribe and wait for subscription to complete
    await subscribeToRealtimeChannel(signalChannel);
    console.log("Host signal channel subscribed", { channelName });
    hostSignalChannelRef.current = signalChannel;
  };

  const stopHeartbeat = () => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  };

  const startHeartbeat = () => {
    stopHeartbeat();
    broadcastLocalHostStatus();
    heartbeatRef.current = setInterval(() => {
      broadcastLocalHostStatus();
    }, HOST_BROADCAST_INTERVAL_MS);
  };

  const teardownHostSessions = () => {
    Array.from(hostSessionsRef.keys()).forEach((peerId) => closeHostSession(peerId));
    Array.from(viewSessionsRef.values()).forEach((pc) => pc.close());
    viewSessionsRef.clear();
  };

  const handleHighlightPeer = useCallback((peerId: string) => {
    const { setActivePeerId } = useChannelStore.getState();
    setActivePeerId(peerId);
  }, []);

  const handleVideoRef = useCallback((peerId: string, element: HTMLVideoElement | null) => {
    if (!element) {
      peerVideoRefs.delete(peerId);
      return;
    }
    peerVideoRefs.set(peerId, element);
    const peer = streamingPeers.find((p) => p.id === peerId);
    if (peer?.stream && element.srcObject !== peer.stream) {
      element.srcObject = peer.stream;
    }
  }, [streamingPeers]);

  // Initialize host on mount, cleanup on unmount
  useEffect(() => {
    const initHost = async () => {
      try {
        if (typeof window === "undefined" || !window.crypto?.subtle) {
          throw new Error("Web Crypto API is not available in this environment.");
        }

        const keyPair = await generateHostKeyPair();
        hostKeyPairRef.current = keyPair;
        const { setHostKeyPair } = useChannelStore.getState();
        setHostKeyPair(keyPair);
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
  }, []);

  // Set up presence channel
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

  // Update peer video elements when streams change (DOM updates only)
  useEffect(() => {
    streamingPeers.forEach((peer) => {
      const video = peerVideoRefs.get(peer.id);
      if (video && peer.stream && video.srcObject !== peer.stream) {
        video.srcObject = peer.stream;
      }
    });
  }, [streamingPeers]);

  // Broadcast status when active peer changes
  useEffect(() => {
    broadcastLocalHostStatus();
  }, [activePeer]);

  // Update viewer streams when active peer changes
  useEffect(() => {
    if (activePeer?.stream) {
      const stream = activePeer.stream;
      viewSessionsRef.forEach((pc: RTCPeerConnection) => {
        // Remove old tracks
        pc.getSenders().forEach((sender: RTCRtpSender) => {
          if (sender.track) {
            pc.removeTrack(sender);
          }
        });
        // Add new tracks from active peer
        stream.getTracks().forEach((track) => {
          pc.addTrack(track, stream);
        });
      });
    }
  }, [activePeer]);

  const hostKey = hostKeyPairRef.current?.publicKeyString ?? "Initializing…";

  return (
    <div className="app">
      <div className="page">
        <div className="card">
          <ScreenHeader
            label="Host channel"
            value={hostKey}
            backButtonLabel="Stop hosting"
            onBack={onBack}
          />

          <section className="section">
            <BroadcastPlayer
              stream={activePeer?.stream ?? null}
              peerLabel={activePeer?.label ?? null}
              peerScreenTitle={activePeer?.screenTitle ?? null}
            />
            <StatsDisplay broadcastPeers={broadcastPeers} activePeerLabel={activePeer?.label ?? null} />
          </section>

          <StreamingPeersSection peerCount={streamingPeers.length}>
            {streamingPeers.length === 0 ? (
              <EmptyState message="No peers are streaming to this channel." />
            ) : (
              <div className="peer-grid">
                {streamingPeers.map((peer) => (
                  <PeerCard
                    key={peer.id}
                    peerId={peer.id}
                    label={peer.label}
                    screenTitle={peer.screenTitle}
                    stream={peer.stream ?? null}
                    isActive={activePeerId === peer.id}
                    onVideoRef={handleVideoRef}
                    onHighlight={handleHighlightPeer}
                  />
                ))}
              </div>
            )}
          </StreamingPeersSection>
        </div>
      </div>
    </div>
  );
}
