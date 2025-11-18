import "./index.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";

type StreamingPeer = {
  id: string;
  label: string;
  screenTitle: string;
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

const peerTemplates: Array<Omit<StreamingPeer, "id">> = [
  { label: "Design review", screenTitle: "Figma handoff workspace" },
  { label: "Docs walkthrough", screenTitle: "Spec: host-auth-webrtc.md" },
  { label: "Infra update", screenTitle: "Terminal session • deploy logs" },
  { label: "Data viz", screenTitle: "Dashboard share • 4k monitor" },
];

const createStreamingPeerSet = () => {
  const shuffled = [...peerTemplates].sort(() => Math.random() - 0.5);
  const slice = shuffled.slice(0, Math.max(1, Math.floor(Math.random() * shuffled.length)));
  return slice.map((peer) => ({
    id: `peer_${randomId()}`,
    label: peer.label,
    screenTitle: peer.screenTitle,
  }));
};

export function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [hostedChannelId, setHostedChannelId] = useState<string | null>(null);
  const [isCreatingChannel, setIsCreatingChannel] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const presenceChannelRef = useRef<RealtimeChannel | null>(null);
  const hostedChannelRef = useRef<Channel | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectedChannel = useMemo(
    () => channels.find((channel) => channel.id === selectedChannelId) ?? null,
    [channels, selectedChannelId]
  );
  const activePeer = selectedChannel
    ? selectedChannel.streamingPeers.find((peer) => peer.id === selectedChannel.activePeerId) ?? null
    : null;

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

  const stopHosting = useCallback(() => {
    const current = hostedChannelRef.current;
    if (!current) return;
    sendHostStop(current.id);
    hostedChannelRef.current = null;
    setHostedChannelId(null);
    stopHeartbeat();
    setChannels((prev) => prev.filter((channel) => channel.id !== current.id));
  }, [sendHostStop, stopHeartbeat]);

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

  const handleAddChannel = useCallback(() => {
    if (isCreatingChannel) return;
    setIsCreatingChannel(true);
    setError(null);
    try {
      if (hostedChannelRef.current) {
        stopHosting();
      }

      const streamingPeers = createStreamingPeerSet();
      const nextChannel: Channel = {
        id: `channel_${randomId()}`,
        hostKey: createHostKey(),
        broadcastPeers: Math.floor(Math.random() * 240) + 16,
        lastActive: Date.now(),
        streamingPeers,
        activePeerId: streamingPeers[0]?.id ?? null,
      };

      hostedChannelRef.current = nextChannel;
      setHostedChannelId(nextChannel.id);
      setChannels((prev) => upsertChannel(prev, nextChannel));
      setSelectedChannelId(nextChannel.id);

      broadcastLocalHostStatus(nextChannel);
      startHeartbeat();
    } catch (err) {
      console.error("Failed to create channel", err);
      setError(err instanceof Error ? err.message : "Failed to create channel");
    } finally {
      setIsCreatingChannel(false);
    }
  }, [broadcastLocalHostStatus, isCreatingChannel, startHeartbeat, stopHosting]);

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
                <button className="secondary-button" type="button">
                  Share screen
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
                          <span>{peer.label}</span>
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
