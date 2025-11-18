import "./index.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import {
  createOffer,
  fetchExistingAnswer,
  fetchPendingOffers,
  saveAnswer,
  subscribeToAnswer,
  subscribeToOffers,
  updateOfferStatus,
} from "./lib/signaling";
import type { OfferRecord } from "./lib/types";

type StreamingPeer = {
  id: string;
  label: string;
  screenTitle: string;
  stream?: MediaStream | null;
  offerId?: string;
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
  offer: OfferRecord;
  pc: RTCPeerConnection;
  stream: MediaStream;
  peerId: string;
  channelId: string;
};

type ShareSession = {
  offerId: string;
  pc: RTCPeerConnection;
  stream: MediaStream;
  unsubscribeAnswer?: () => Promise<void>;
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

const HOST_DIRECTORY_CHANNEL = "host-directory";
const HOST_STATUS_EVENT = "host-status";
const HOST_STOP_EVENT = "host-stop";
const HOST_TIMEOUT_MS = 60_000;
const HOST_BROADCAST_INTERVAL_MS = 2_000;
const STALE_SWEEP_INTERVAL_MS = 5_000;

const randomId = () => Math.random().toString(36).slice(2, 10);
const createHostKey = () => `pk_${randomId()}${randomId()}`.toUpperCase();
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
  const hostOfferUnsubRef = useRef<(() => Promise<void>) | null>(null);
  const hostSessionsRef = useRef<Map<string, HostSession>>(new Map());
  const shareSessionRef = useRef<ShareSession | null>(null);
  const peerVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());

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

  const upsertStreamingPeer = useCallback(
    (channelId: string, peer: StreamingPeer) => {
      mutateChannel(channelId, (channel) => {
        const peers = channel.streamingPeers.filter((item) => item.id !== peer.id);
        peers.push(peer);
        return { ...channel, streamingPeers: peers };
      });
    },
    [mutateChannel]
  );

  const updateStreamingPeer = useCallback(
    (channelId: string, peerId: string, updater: (peer: StreamingPeer) => StreamingPeer) => {
      mutateChannel(channelId, (channel) => {
        const peers = channel.streamingPeers.map((peer) => (peer.id === peerId ? updater(peer) : peer));
        return { ...channel, streamingPeers: peers };
      });
    },
    [mutateChannel]
  );

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
    (offerId: string) => {
      const session = hostSessionsRef.current.get(offerId);
      if (!session) return;
      session.stream.getTracks().forEach((track) => track.stop());
      session.pc.ontrack = null;
      session.pc.onconnectionstatechange = null;
      session.pc.close();
      hostSessionsRef.current.delete(offerId);
      removeStreamingPeer(session.channelId, session.peerId);
    },
    [removeStreamingPeer]
  );

  const teardownHostSessions = useCallback(() => {
    Array.from(hostSessionsRef.current.keys()).forEach((offerId) => closeHostSession(offerId));
    if (hostOfferUnsubRef.current) {
      hostOfferUnsubRef.current().catch(() => null);
      hostOfferUnsubRef.current = null;
    }
  }, [closeHostSession]);

  const stopHosting = useCallback(() => {
    const current = hostedChannelRef.current;
    if (!current) return;
    sendHostStop(current.id);
    hostedChannelRef.current = null;
    setHostedChannelId(null);
    stopHeartbeat();
    teardownHostSessions();
    setChannels((prev) => prev.filter((channel) => channel.id !== current.id));
  }, [sendHostStop, stopHeartbeat, teardownHostSessions]);

  const attachStreamToPeer = useCallback(
    (channelId: string, peerId: string, stream: MediaStream, label: string, offerId: string) => {
      mutateChannel(channelId, (channel) => {
        const peers = channel.streamingPeers.filter((item) => item.id !== peerId);
        peers.push({
          id: peerId,
          label,
          screenTitle: "Live screen share",
          stream,
          offerId,
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

  const autoAcceptOffer = useCallback(
    async (channel: Channel, offer: OfferRecord) => {
      if (hostSessionsRef.current.has(offer.id)) return;
      try {
        const pc = createPeerConnection();
        const stream = new MediaStream();
        const peerId = `peer_${randomId()}`;
        hostSessionsRef.current.set(offer.id, { offer, pc, stream, peerId, channelId: channel.id });

        pc.ontrack = (event) => {
          if (event.streams && event.streams[0]) {
            attachStreamToPeer(channel.id, peerId, event.streams[0], offer.caster_name ?? "Guest share", offer.id);
          } else {
            stream.addTrack(event.track);
            attachStreamToPeer(channel.id, peerId, stream, offer.caster_name ?? "Guest share", offer.id);
          }
        };

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed") {
            closeHostSession(offer.id);
          }
        };

        await pc.setRemoteDescription(offer.offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitForIceGathering(pc);
        if (!pc.localDescription) throw new Error("Missing local description");
        await saveAnswer(offer.id, pc.localDescription);
        await updateOfferStatus(offer.id, "accepted");
      } catch (err) {
        console.error("Failed to accept offer", err);
        closeHostSession(offer.id);
        await updateOfferStatus(offer.id, "denied").catch(() => null);
      }
    },
    [attachStreamToPeer, closeHostSession]
  );

  const startHostOfferListener = useCallback(
    async (channel: Channel) => {
      const hostKey = channel.hostKey.toUpperCase();

      const handleOfferRecord = (record: OfferRecord) => {
        if ((record.room_code ?? "").toUpperCase() !== hostKey) return;
        if (record.status === "pending") {
          autoAcceptOffer(channel, record);
        } else if (record.status === "completed" || record.status === "denied") {
          closeHostSession(record.id);
        }
      };

      try {
        const pending = await fetchPendingOffers();
        pending.forEach(handleOfferRecord);
      } catch (err) {
        console.error("Failed to fetch pending offers", err);
      }

      hostOfferUnsubRef.current = subscribeToOffers((record) => {
        handleOfferRecord(record);
      });
    },
    [autoAcceptOffer, closeHostSession]
  );

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
    channels.forEach((channel) => {
      channel.streamingPeers.forEach((peer) => {
        const video = peerVideoRefs.current.get(peer.id);
        if (video && peer.stream && video.srcObject !== peer.stream) {
          video.srcObject = peer.stream;
        }
      });
    });
  }, [channels]);

  const handleAddChannel = useCallback(() => {
    if (isCreatingChannel) return;
    setIsCreatingChannel(true);
    setError(null);
    try {
      if (hostedChannelRef.current) {
        stopHosting();
      }

      const nextChannel: Channel = {
        id: `channel_${randomId()}`,
        hostKey: createHostKey(),
        broadcastPeers: Math.floor(Math.random() * 240) + 16,
        lastActive: Date.now(),
        streamingPeers: [],
        activePeerId: null,
      };

      hostedChannelRef.current = nextChannel;
      setHostedChannelId(nextChannel.id);
      setChannels((prev) => upsertChannel(prev, nextChannel));
      setSelectedChannelId(nextChannel.id);

      broadcastLocalHostStatus(nextChannel);
      startHeartbeat();
      startHostOfferListener(nextChannel);
    } catch (err) {
      console.error("Failed to create channel", err);
      setError(err instanceof Error ? err.message : "Failed to create channel");
    } finally {
      setIsCreatingChannel(false);
    }
  }, [broadcastLocalHostStatus, isCreatingChannel, startHeartbeat, startHostOfferListener, stopHosting]);

  const stopShareSession = useCallback(async () => {
    const session = shareSessionRef.current;
    if (!session) return;
    shareSessionRef.current = null;
    session.stream.getTracks().forEach((track) => track.stop());
    session.pc.onconnectionstatechange = null;
    session.pc.close();
    if (session.unsubscribeAnswer) {
      await session.unsubscribeAnswer().catch(() => null);
    }
    await updateOfferStatus(session.offerId, "completed").catch(() => null);
    setShareStatus("idle");
    setShareError(null);
  }, []);

  const handleShareScreen = useCallback(async () => {
    if (shareSessionRef.current) {
      await stopShareSession();
      return;
    }
    if (!selectedChannel) {
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
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);
      if (!pc.localDescription) throw new Error("Missing local description");

      setShareStatus("publishing");
      const record = await createOffer({
        offer: pc.localDescription,
        casterName: shareAlias.trim() || "Guest share",
        roomCode: selectedChannel.hostKey,
      });
      setShareStatus("awaiting");

      const applyAnswer = async (answer: RTCSessionDescriptionInit) => {
        const description =
          typeof RTCSessionDescription !== "undefined" ? new RTCSessionDescription(answer) : answer;
        await pc.setRemoteDescription(description);
        setShareStatus("connected");
      };

      const unsubscribe = subscribeToAnswer(record.id, async (payload) => {
        await applyAnswer(payload.answer);
      });
      const existingAnswer = await fetchExistingAnswer(record.id);
      if (existingAnswer) {
        await applyAnswer(existingAnswer.answer);
      }

      shareSessionRef.current = {
        offerId: record.id,
        pc,
        stream,
        unsubscribeAnswer: unsubscribe,
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed") {
          stopShareSession().catch(() => null);
        }
      };
    } catch (err) {
      console.error("Failed to start screen share", err);
      setShareStatus("error");
      setShareError(err instanceof Error ? err.message : "Failed to start screen share");
      await stopShareSession();
    }
  }, [selectedChannel, shareAlias, stopShareSession]);

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
                onClick={() => setSelectedChannelId(channel.id)}
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
                <button className="secondary-button" type="button" onClick={handleShareScreen} disabled={shareButtonDisabled}>
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
