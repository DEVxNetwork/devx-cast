/**
 * Channel subscription management using Zustand subscriptions
 * This replaces useEffect hooks for side effects
 */
import { supabase } from "./supabase";
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

let staleSweepInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Initialize channel list subscriptions
 * This sets up Supabase realtime subscriptions and stale channel cleanup
 */
export function initChannelListSubscriptions() {
  // Set up Supabase channel subscription
  const channel = supabase.channel(HOST_DIRECTORY_CHANNEL, {
    config: { broadcast: { self: true } },
  });
  presenceChannelRef.current = channel;

  channel
    .on("broadcast", { event: HOST_STATUS_EVENT }, ({ payload }) => {
      const p = payload as HostStatusPayload;
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
      const { removeChannel } = useChannelStore.getState();
      removeChannel(p.hostId);
    })
    .subscribe();

  // Set up stale channel cleanup
  if (staleSweepInterval) {
    clearInterval(staleSweepInterval);
  }
  staleSweepInterval = setInterval(() => {
    const cutoff = Date.now() - HOST_TIMEOUT_MS;
    const { channels, removeChannel } = useChannelStore.getState();
    channels.forEach((ch) => {
      if (ch.lastActive < cutoff) {
        removeChannel(ch.id);
      }
    });
  }, STALE_SWEEP_INTERVAL_MS);

  return () => {
    channel.unsubscribe();
    presenceChannelRef.current = null;
    if (staleSweepInterval) {
      clearInterval(staleSweepInterval);
      staleSweepInterval = null;
    }
  };
}

