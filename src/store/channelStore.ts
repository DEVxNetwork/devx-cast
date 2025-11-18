import { create } from "zustand";
import type { RealtimeChannel } from "@supabase/supabase-js";

export type Channel = {
  id: string;
  hostKey: string;
  broadcastPeers: number;
  lastActive: number;
};

export type StreamingPeer = {
  id: string;
  label: string;
  screenTitle: string;
  stream?: MediaStream | null;
  sessionId?: string;
};

// Note: RTCPeerConnection, MediaStream, and RealtimeChannel are not stored in Zustand
// They are managed via refs in components/services since they're non-serializable

type ShareStatus = "idle" | "prompting" | "publishing" | "awaiting" | "connected" | "error";
type ViewStatus = "idle" | "connecting" | "connected" | "error";
type Screen = "channel-list" | "channel" | "host-channel";

interface ChannelStore {
  // Navigation state
  screen: Screen;
  selectedChannelHostKey: string | null;
  hostChannelId: string | null;
  setScreen: (screen: Screen) => void;
  setSelectedChannelHostKey: (hostKey: string | null) => void;
  setHostChannelId: (channelId: string | null) => void;
  navigateToChannelList: () => void;
  navigateToChannel: (hostKey: string) => void;
  navigateToHostChannel: (channelId: string) => void;

  // Channel list state
  channels: Channel[];
  addChannel: (channel: Channel) => void;
  updateChannel: (channelId: string, updates: Partial<Channel>) => void;
  removeChannel: (channelId: string) => void;
  clearChannels: () => void;

  // Host state
  hostChannelId: string | null;
  hostKeyPair: { publicKey: CryptoKey; privateKey: CryptoKey; publicKeyString: string } | null;
  streamingPeers: StreamingPeer[];
  activePeerId: string | null;
  broadcastPeers: number;
  
  // Host actions
  setHostChannelId: (id: string | null) => void;
  setHostKeyPair: (keyPair: { publicKey: CryptoKey; privateKey: CryptoKey; publicKeyString: string } | null) => void;
  addStreamingPeer: (peer: StreamingPeer) => void;
  updateStreamingPeer: (peerId: string, updates: Partial<StreamingPeer>) => void;
  removeStreamingPeer: (peerId: string) => void;
  setActivePeerId: (peerId: string | null) => void;
  setBroadcastPeers: (count: number) => void;
  clearHostState: () => void;

  // Note: WebRTC sessions (RTCPeerConnection, MediaStream, RealtimeChannel) are managed
  // via refs in components/services, not in Zustand store since they're non-serializable

  // Peer state (for ChannelPeerScreen)
  shareStatus: ShareStatus;
  shareError: string | null;
  shareAlias: string;
  viewStatus: ViewStatus;
  viewError: string | null;

  // Peer actions
  setShareStatus: (status: ShareStatus) => void;
  setShareError: (error: string | null) => void;
  setShareAlias: (alias: string) => void;
  setViewStatus: (status: ViewStatus) => void;
  setViewError: (error: string | null) => void;
  clearPeerState: () => void;

  // Note: WebRTC sessions are managed via refs, not in Zustand
}

export const useChannelStore = create<ChannelStore>((set, get) => ({
  // Navigation state
  screen: "channel-list",
  selectedChannelHostKey: null,
  hostChannelId: null,
  setScreen: (screen) => set({ screen }),
  setSelectedChannelHostKey: (hostKey) => set({ selectedChannelHostKey: hostKey }),
  setHostChannelId: (channelId) => set({ hostChannelId: channelId }),
  navigateToChannelList: () =>
    set({
      screen: "channel-list",
      selectedChannelHostKey: null,
      hostChannelId: null,
    }),
  navigateToChannel: (hostKey) =>
    set({
      screen: "channel",
      selectedChannelHostKey: hostKey,
    }),
  navigateToHostChannel: (channelId) =>
    set({
      screen: "host-channel",
      hostChannelId: channelId,
    }),

  // Channel list state
  channels: [],
  addChannel: (channel) =>
    set((state) => {
      const existing = state.channels.find((c) => c.id === channel.id);
      if (existing) {
        const updated = state.channels.map((c) => (c.id === channel.id ? { ...c, ...channel } : c));
        return { channels: updated.sort((a, b) => b.lastActive - a.lastActive) };
      }
      return { channels: [...state.channels, channel].sort((a, b) => b.lastActive - a.lastActive) };
    }),
  updateChannel: (channelId, updates) =>
    set((state) => ({
      channels: state.channels.map((c) => (c.id === channelId ? { ...c, ...updates } : c)),
    })),
  removeChannel: (channelId) =>
    set((state) => ({
      channels: state.channels.filter((c) => c.id !== channelId),
    })),
  clearChannels: () => set({ channels: [] }),

  // Host state
  hostChannelId: null,
  hostKeyPair: null,
  streamingPeers: [],
  activePeerId: null,
  broadcastPeers: 0,

  // Host actions
  setHostChannelId: (id) => set({ hostChannelId: id }),
  setHostKeyPair: (keyPair) => set({ hostKeyPair: keyPair }),
  addStreamingPeer: (peer) =>
    set((state) => {
      const existing = state.streamingPeers.find((p) => p.id === peer.id);
      if (existing) return state;
      return {
        streamingPeers: [...state.streamingPeers, peer],
        broadcastPeers: state.streamingPeers.length + 1,
      };
    }),
  updateStreamingPeer: (peerId, updates) =>
    set((state) => ({
      streamingPeers: state.streamingPeers.map((p) => (p.id === peerId ? { ...p, ...updates } : p)),
    })),
  removeStreamingPeer: (peerId) =>
    set((state) => {
      const peers = state.streamingPeers.filter((p) => p.id !== peerId);
      return {
        streamingPeers: peers,
        broadcastPeers: peers.length,
        activePeerId: state.activePeerId === peerId ? (peers[0]?.id ?? null) : state.activePeerId,
      };
    }),
  setActivePeerId: (peerId) => set({ activePeerId: peerId }),
  setBroadcastPeers: (count) => set({ broadcastPeers: count }),
  clearHostState: () =>
    set({
      hostChannelId: null,
      hostKeyPair: null,
      streamingPeers: [],
      activePeerId: null,
      broadcastPeers: 0,
    }),

  // WebRTC sessions are managed via refs in components/services

  // Peer state
  shareStatus: "idle",
  shareError: null,
  shareAlias: "Guest share",
  viewStatus: "idle",
  viewError: null,

  // Peer actions
  setShareStatus: (status) => set({ shareStatus: status }),
  setShareError: (error) => set({ shareError: error }),
  setShareAlias: (alias) => set({ shareAlias: alias }),
  setViewStatus: (status) => set({ viewStatus: status }),
  setViewError: (error) => set({ viewError: error }),
  clearPeerState: () =>
    set({
      shareStatus: "idle",
      shareError: null,
      shareAlias: "Guest share",
      viewStatus: "idle",
      viewError: null,
    }),

  // WebRTC sessions are managed via refs in components/services
}));

