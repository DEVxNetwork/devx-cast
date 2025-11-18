import { useChannelStore } from "./channelStore";
import type { RealtimeChannel } from "@supabase/supabase-js";

/**
 * Helper hooks for accessing specific parts of the store
 * This prevents unnecessary re-renders by selecting only what's needed
 */

// Navigation selectors - use individual selectors to avoid object recreation
export const useScreen = () => useChannelStore((state) => state.screen);
export const useSelectedChannelHostKey = () => useChannelStore((state) => state.selectedChannelHostKey);
export const useHostChannelId = () => useChannelStore((state) => state.hostChannelId);

export const useNavigateToChannelList = () => useChannelStore((state) => state.navigateToChannelList);
export const useNavigateToChannel = () => useChannelStore((state) => state.navigateToChannel);
export const useNavigateToHostChannel = () => useChannelStore((state) => state.navigateToHostChannel);

// Channel list selectors
export const useChannels = () => useChannelStore((state) => state.channels);
export const useChannelActions = () =>
  useChannelStore((state) => ({
    addChannel: state.addChannel,
    updateChannel: state.updateChannel,
    removeChannel: state.removeChannel,
    clearChannels: state.clearChannels,
  }));

// Host selectors - use individual selectors to avoid object recreation
export const useHostKeyPair = () => useChannelStore((state) => state.hostKeyPair);
export const useStreamingPeers = () => useChannelStore((state) => state.streamingPeers);
export const useActivePeerId = () => useChannelStore((state) => state.activePeerId);
export const useBroadcastPeers = () => useChannelStore((state) => state.broadcastPeers);

export const useSetHostChannelId = () => useChannelStore((state) => state.setHostChannelId);
export const useSetHostKeyPair = () => useChannelStore((state) => state.setHostKeyPair);
export const useAddStreamingPeer = () => useChannelStore((state) => state.addStreamingPeer);
export const useUpdateStreamingPeer = () => useChannelStore((state) => state.updateStreamingPeer);
export const useRemoveStreamingPeer = () => useChannelStore((state) => state.removeStreamingPeer);
export const useSetActivePeerId = () => useChannelStore((state) => state.setActivePeerId);
export const useSetBroadcastPeers = () => useChannelStore((state) => state.setBroadcastPeers);
export const useClearHostState = () => useChannelStore((state) => state.clearHostState);

// WebRTC sessions are managed via refs in components/services

// Peer selectors - use individual selectors to avoid object recreation
export const useShareStatus = () => useChannelStore((state) => state.shareStatus);
export const useShareError = () => useChannelStore((state) => state.shareError);
export const useShareAlias = () => useChannelStore((state) => state.shareAlias);
export const useViewStatus = () => useChannelStore((state) => state.viewStatus);
export const useViewError = () => useChannelStore((state) => state.viewError);

export const useSetShareStatus = () => useChannelStore((state) => state.setShareStatus);
export const useSetShareError = () => useChannelStore((state) => state.setShareError);
export const useSetShareAlias = () => useChannelStore((state) => state.setShareAlias);
export const useSetViewStatus = () => useChannelStore((state) => state.setViewStatus);
export const useSetViewError = () => useChannelStore((state) => state.setViewError);
export const useClearPeerState = () => useChannelStore((state) => state.clearPeerState);

// WebRTC sessions are managed via refs in components/services

// Computed selectors
export const useActivePeer = () =>
  useChannelStore((state) => {
    if (!state.activePeerId) return null;
    return state.streamingPeers.find((p) => p.id === state.activePeerId) ?? null;
  });

