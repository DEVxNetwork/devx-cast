/**
 * Centralized refs for WebRTC connections and non-reactive state
 * These are not in Zustand because they're non-serializable objects
 */
import type { RealtimeChannel } from "@supabase/supabase-js";

export type HostSession = {
  peerId: string;
  alias: string;
  nonce: string;
  pc: RTCPeerConnection;
  stream: MediaStream;
  channelId: string;
};

export type ShareSession = {
  peerId: string;
  nonce: string;
  hostKey: string;
  pc: RTCPeerConnection;
  stream: MediaStream;
  signalChannel: RealtimeChannel;
};

export type ViewSession = {
  peerId: string;
  pc: RTCPeerConnection;
  stream: MediaStream | null;
  signalChannel: RealtimeChannel;
};

// Host refs - Maps are direct, objects use .current pattern
export const hostSessionsRef = new Map<string, HostSession>();
export const viewSessionsRef = new Map<string, RTCPeerConnection>();
export const peerVideoRefs = new Map<string, HTMLVideoElement>();
export const hostKeyPairRef: { current: { publicKey: CryptoKey; privateKey: CryptoKey; publicKeyString: string } | null } = { current: null };
export const hostSignalChannelRef: { current: RealtimeChannel | null } = { current: null };
export const presenceChannelRef: { current: RealtimeChannel | null } = { current: null };
export const heartbeatRef: { current: ReturnType<typeof setInterval> | null } = { current: null };
export const hostVideoRef: { current: HTMLVideoElement | null } = { current: null };

// Peer refs
export const shareSessionRef: { current: ShareSession | null } = { current: null };
export const viewSessionRef: { current: ViewSession | null } = { current: null };
export const viewVideoRef: { current: HTMLVideoElement | null } = { current: null };
export const verifyKeyCacheRef = new Map<string, CryptoKey>();

// Helper functions
export const clearHostRefs = () => {
  hostSessionsRef.forEach((session) => {
    session.stream.getTracks().forEach((track) => track.stop());
    session.pc.close();
  });
  hostSessionsRef.clear();
  
  viewSessionsRef.forEach((pc) => pc.close());
  viewSessionsRef.clear();
  
  if (hostSignalChannelRef.current) {
    hostSignalChannelRef.current.unsubscribe().catch(() => null);
    hostSignalChannelRef.current = null;
  }
  
  if (presenceChannelRef.current) {
    presenceChannelRef.current.unsubscribe().catch(() => null);
    presenceChannelRef.current = null;
  }
  
  if (heartbeatRef.current) {
    clearInterval(heartbeatRef.current);
    heartbeatRef.current = null;
  }
  
  hostKeyPairRef.current = null;
  peerVideoRefs.clear();
  hostVideoRef.current = null;
};

export const clearPeerRefs = async () => {
  if (shareSessionRef.current) {
    shareSessionRef.current.stream.getTracks().forEach((track) => track.stop());
    shareSessionRef.current.pc.close();
    await shareSessionRef.current.signalChannel.unsubscribe().catch(() => null);
    shareSessionRef.current = null;
  }
  
  if (viewSessionRef.current) {
    if (viewSessionRef.current.stream) {
      viewSessionRef.current.stream.getTracks().forEach((track) => track.stop());
    }
    viewSessionRef.current.pc.close();
    await viewSessionRef.current.signalChannel.unsubscribe().catch(() => null);
    viewSessionRef.current = null;
  }
  
  if (viewVideoRef.current) {
    viewVideoRef.current.srcObject = null;
    viewVideoRef.current = null;
  }
  
  verifyKeyCacheRef.clear();
};

