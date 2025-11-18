import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

type Channel = {
  id: string;
  hostKey: string;
  broadcastPeers: number;
  lastActive: number;
};

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

const sortByRecency = (a: Channel, b: Channel) => (a.lastActive < b.lastActive ? 1 : -1);
const upsertChannel = (channels: Channel[], updated: Channel) => {
  const filtered = channels.filter((channel) => channel.id !== updated.id);
  filtered.push(updated);
  return filtered.sort(sortByRecency);
};

type ChannelListScreenProps = {
  onStartChannel: () => void;
  onSelectChannel: (hostKey: string) => void;
};

export function ChannelListScreen({ onStartChannel, onSelectChannel }: ChannelListScreenProps) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const presenceChannelRef = useRef<RealtimeChannel | null>(null);

  const handleHostStatus = useCallback((payload: HostStatusPayload) => {
    setChannels((prev) => {
      const existing = prev.find((channel) => channel.id === payload.hostId);
      const merged: Channel = {
        id: payload.hostId,
        hostKey: payload.hostKey,
        broadcastPeers: payload.broadcastPeers ?? existing?.broadcastPeers ?? 0,
        lastActive: payload.timestamp,
      };
      return upsertChannel(prev, merged);
    });
  }, []);

  const handleHostStop = useCallback((payload: HostStopPayload) => {
    setChannels((prev) => prev.filter((channel) => channel.id !== payload.hostId));
  }, []);

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
      .subscribe();

    return () => {
      channel.unsubscribe();
      presenceChannelRef.current = null;
    };
  }, [handleHostStatus, handleHostStop]);

  useEffect(() => {
    const interval = setInterval(() => {
      setChannels((prev) => {
        const cutoff = Date.now() - HOST_TIMEOUT_MS;
        return prev.filter((channel) => channel.lastActive >= cutoff);
      });
    }, STALE_SWEEP_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

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

