import { useEffect, useCallback } from "react";
import { supabase } from "../lib/supabase";
import {
  useStreamingPeers,
  useActivePeerId,
  useBroadcastPeers,
  useActivePeer,
  useInitializeHost,
  useStopHeartbeat,
  useTeardownHostSessions,
  useHandleHighlightPeer,
  useBroadcastLocalHostStatus,
} from "../store/channelStoreHelpers";
import { hostKeyPairRef, presenceChannelRef, peerVideoRefs, hostSignalChannelRef, viewSessionsRef } from "../store/webrtcRefs";
import { HOST_DIRECTORY_CHANNEL } from "../lib/webrtcUtils";
import { ScreenHeader } from "../components/ScreenHeader";
import { BroadcastPlayer } from "../components/BroadcastPlayer";
import { StatsDisplay } from "../components/StatsDisplay";
import { StreamingPeersSection } from "../components/StreamingPeersSection";
import { PeerCard } from "../components/PeerCard";
import { EmptyState } from "../components/EmptyState";

type ChannelHostScreenProps = {
  channelId: string;
  onBack: () => void;
};

export function ChannelHostScreen({ channelId, onBack }: ChannelHostScreenProps) {
  const streamingPeers = useStreamingPeers();
  const activePeerId = useActivePeerId();
  const broadcastPeers = useBroadcastPeers();
  const activePeer = useActivePeer();
  const initializeHost = useInitializeHost();
  const stopHeartbeat = useStopHeartbeat();
  const teardownHostSessions = useTeardownHostSessions();
  const handleHighlightPeer = useHandleHighlightPeer();
  const broadcastLocalHostStatus = useBroadcastLocalHostStatus();

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
    initializeHost(channelId);

    return () => {
      stopHeartbeat();
      teardownHostSessions();
      if (hostSignalChannelRef.current) {
        hostSignalChannelRef.current.unsubscribe().catch(() => null);
      }
    };
  }, [channelId, initializeHost, stopHeartbeat, teardownHostSessions]);

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
    broadcastLocalHostStatus(channelId);
  }, [activePeer, channelId, broadcastLocalHostStatus]);

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
