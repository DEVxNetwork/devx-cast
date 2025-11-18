import { useEffect } from "react";
import { supabase } from "../lib/supabase";
import { useChannels } from "../store/channelStoreHelpers";
import { useChannelStore } from "../store/channelStore";
import { presenceChannelRef } from "../store/webrtcRefs";
import type { Channel } from "../store/channelStore";

type HostStatusPayload = {
  hostId: string;
  hostKey: string;
  broadcastPeers: number;
  timestamp: number;
};

type HostStopPayload = { hostId: string };

const HOST_DIRECTORY_CHANNEL = "host-directory";
const HOST_STATUS_EVENT = "host-status";
const HOST_STOP_EVENT = "host-stop";
const HOST_TIMEOUT_MS = 60_000;
const STALE_SWEEP_INTERVAL_MS = 5_000;

type ChannelListScreenProps = {
  onStartChannel: () => void;
  onSelectChannel: (hostKey: string) => void;
};

export function ChannelListScreen({ onStartChannel, onSelectChannel }: ChannelListScreenProps) {
  const channels = useChannels();

  useEffect(() => {
    const channel = supabase.channel(HOST_DIRECTORY_CHANNEL, {
      config: { broadcast: { self: true } },
    });
    presenceChannelRef.current = channel;

    channel
      .on("broadcast", { event: HOST_STATUS_EVENT }, ({ payload }) => {
        const p = payload as HostStatusPayload;
        // Access actions directly from store to avoid dependency issues
        const { addChannel } = useChannelStore.getState();
        addChannel({
          id: p.hostId,
          hostKey: p.hostKey,
          broadcastPeers: p.broadcastPeers ?? 0,
          lastActive: p.timestamp,
        });
      })
      .on("broadcast", { event: HOST_STOP_EVENT }, ({ payload }) => {
        const p = payload as HostStopPayload;
        // Access actions directly from store to avoid dependency issues
        const { removeChannel } = useChannelStore.getState();
        removeChannel(p.hostId);
      })
      .subscribe();

    return () => {
      channel.unsubscribe();
      presenceChannelRef.current = null;
    };
  }, []); // Empty deps - access store directly

  useEffect(() => {
    const interval = setInterval(() => {
      const cutoff = Date.now() - HOST_TIMEOUT_MS;
      // Access channels and actions directly from store to avoid dependency loop
      const currentChannels = useChannelStore.getState().channels;
      const { removeChannel } = useChannelStore.getState();
      currentChannels.forEach((ch) => {
        if (ch.lastActive < cutoff) {
          removeChannel(ch.id);
        }
      });
    }, STALE_SWEEP_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []); // Empty deps - access store directly

  return (
    <div className="app">
      <div className="page">
        <div className="card">
          <header className="header">
            <div className="header-content">
              <h1>Active Channels</h1>
              <p className="muted">{channels.length} channel{channels.length !== 1 ? "s" : ""} available</p>
            </div>
          </header>

          <section className="section">
            <div className="channel-list">
              {channels.length === 0 ? (
                <p className="muted">Waiting for hosts to appear…</p>
              ) : (
                channels.map((channel) => (
                  <button
                    key={channel.id}
                    className="channel-item"
                    onClick={() => onSelectChannel(channel.hostKey)}
                  >
                    <div>
                      <p className="label">Host public key</p>
                      <code>{channel.hostKey}</code>
                    </div>
                    <span>{channel.broadcastPeers} peer{channel.broadcastPeers !== 1 ? "s" : ""}</span>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="section">
            <button className="btn btn-primary" onClick={onStartChannel}>
              Start Channel
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}

