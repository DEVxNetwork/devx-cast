import { create } from "zustand";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import {
  shareSessionRef,
  viewSessionRef,
  verifyKeyCacheRef,
  hostSessionsRef,
  viewSessionsRef,
  hostKeyPairRef,
  hostSignalChannelRef,
  presenceChannelRef,
  heartbeatRef,
} from "./webrtcRefs";
import {
  getSignalChannelName,
  PEER_OFFER_EVENT,
  HOST_ANSWER_EVENT,
  HOST_TERMINATE_EVENT,
  VIEW_OFFER_EVENT,
  VIEW_ANSWER_EVENT,
  HOST_DIRECTORY_CHANNEL,
  HOST_STATUS_EVENT,
  HOST_BROADCAST_INTERVAL_MS,
  subscribeToRealtimeChannel,
  importHostPublicKey,
  verifyHostSignature,
  signPayload,
  generateHostKeyPair,
  randomId,
  waitForIceGathering,
  createPeerConnection,
} from "../lib/webrtcUtils";
import type { PeerOfferMessage, HostAnswerMessage, HostStatusPayload } from "../lib/webrtcTypes";

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
  viewStream: MediaStream | null;

  // Peer actions
  setShareStatus: (status: ShareStatus) => void;
  setShareError: (error: string | null) => void;
  setShareAlias: (alias: string) => void;
  setViewStatus: (status: ViewStatus) => void;
  setViewError: (error: string | null) => void;
  setViewStream: (stream: MediaStream | null) => void;
  clearPeerState: () => void;

  // Peer handlers
  handleShareScreen: (hostKey: string) => Promise<void>;
  handleViewStream: (hostKey: string) => Promise<void>;
  stopShareSession: () => Promise<void>;
  stopViewSession: () => Promise<void>;

  // Host handlers
  initializeHost: (channelId: string) => Promise<void>;
  handlePeerOffer: (payload: PeerOfferMessage, channelId: string) => Promise<void>;
  handleViewOffer: (payload: { peerId: string; offer: RTCSessionDescriptionInit }) => Promise<void>;
  broadcastLocalHostStatus: (channelId: string) => void;
  startHostSignalChannel: (hostKey: string) => Promise<void>;
  startHeartbeat: (channelId: string) => void;
  stopHeartbeat: () => void;
  teardownHostSessions: () => void;
  handleHighlightPeer: (peerId: string) => void;

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
  viewStream: null,

  // Peer actions
  setShareStatus: (status) => set({ shareStatus: status }),
  setShareError: (error) => set({ shareError: error }),
  setShareAlias: (alias) => set({ shareAlias: alias }),
  setViewStatus: (status) => set({ viewStatus: status }),
  setViewError: (error) => set({ viewError: error }),
  setViewStream: (stream) => set({ viewStream: stream }),
  clearPeerState: () =>
    set({
      shareStatus: "idle",
      shareError: null,
      shareAlias: "Guest share",
      viewStatus: "idle",
      viewError: null,
      viewStream: null,
    }),

  // Peer handlers
  stopShareSession: async () => {
    const session = shareSessionRef.current;
    if (!session) return;
    shareSessionRef.current = null;
    session.stream.getTracks().forEach((track) => track.stop());
    session.pc.onconnectionstatechange = null;
    session.pc.close();
    await session.signalChannel.unsubscribe().catch(() => null);
    get().setShareStatus("idle");
    get().setShareError(null);
  },

  stopViewSession: async () => {
    const session = viewSessionRef.current;
    if (!session) return;
    viewSessionRef.current = null;
    if (session.stream) {
      session.stream.getTracks().forEach((track) => track.stop());
    }
    session.pc.onconnectionstatechange = null;
    session.pc.ontrack = null;
    session.pc.close();
    await session.signalChannel.unsubscribe().catch(() => null);
    get().setViewStream(null);
    get().setViewStatus("idle");
    get().setViewError(null);
  },

  handleShareScreen: async (hostKey: string) => {
    const state = get();
    if (shareSessionRef.current) {
      await state.stopShareSession();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      state.setShareError("Screen sharing is not supported in this browser.");
      return;
    }
    state.setShareError(null);
    state.setShareStatus("prompting");

    const getVerifyKey = async (hostKey: string) => {
      const cached = verifyKeyCacheRef.get(hostKey);
      if (cached) return cached;
      const imported = await importHostPublicKey(hostKey);
      verifyKeyCacheRef.set(hostKey, imported);
      return imported;
    };

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      if (!stream.getVideoTracks().length) {
        throw new Error("No video track captured");
      }

      const pc = createPeerConnection();
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const signalChannel = supabase.channel(getSignalChannelName(hostKey), {
        config: { broadcast: { self: true } },
      });
      const peerId = `peer_${randomId()}`;
      const nonce = `nonce_${randomId()}${randomId()}`;

      signalChannel.on("broadcast", { event: HOST_ANSWER_EVENT }, async ({ payload }) => {
        const message = payload as HostAnswerMessage;
        if (message.peerId !== peerId || message.nonce !== nonce) return;
        const verifyKey = await getVerifyKey(hostKey);
        const isValid = await verifyHostSignature(
          verifyKey,
          { peerId: message.peerId, nonce: message.nonce, answer: message.answer },
          message.signature
        );
        if (!isValid) {
          get().setShareError("Host signature is invalid.");
          await get().stopShareSession();
          return;
        }
        const description =
          typeof RTCSessionDescription !== "undefined"
            ? new RTCSessionDescription(message.answer)
            : message.answer;
        await pc.setRemoteDescription(description);
        get().setShareStatus("connected");
      });

      signalChannel.on("broadcast", { event: HOST_TERMINATE_EVENT }, () => {
        get().stopShareSession().catch(() => null);
      });

      await subscribeToRealtimeChannel(signalChannel);

      shareSessionRef.current = {
        peerId,
        nonce,
        hostKey,
        pc,
        stream,
        signalChannel,
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          get().stopShareSession().catch(() => null);
        } else if (pc.connectionState === "connected") {
          console.log("Peer share connection established");
        }
      };

      get().setShareStatus("publishing");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);
      if (!pc.localDescription) throw new Error("Missing local description");

      get().setShareStatus("awaiting");
      console.log("Peer sending offer to host", { peerId, hostKey, channelName: getSignalChannelName(hostKey) });
      await signalChannel.send({
        type: "broadcast",
        event: PEER_OFFER_EVENT,
        payload: {
          peerId,
          alias: state.shareAlias.trim() || "Guest share",
          offer: pc.localDescription,
          nonce,
          timestamp: Date.now(),
        } satisfies PeerOfferMessage,
      });
      console.log("Peer offer sent", { peerId });
    } catch (err) {
      console.error("Failed to start screen share", err);
      get().setShareStatus("error");
      get().setShareError(err instanceof Error ? err.message : "Failed to start screen share");
      await get().stopShareSession();
    }
  },

  handleViewStream: async (hostKey: string) => {
    const state = get();
    if (viewSessionRef.current) {
      await state.stopViewSession();
      return;
    }
    state.setViewError(null);
    state.setViewStatus("connecting");

    const getVerifyKey = async (hostKey: string) => {
      const cached = verifyKeyCacheRef.get(hostKey);
      if (cached) return cached;
      const imported = await importHostPublicKey(hostKey);
      verifyKeyCacheRef.set(hostKey, imported);
      return imported;
    };

    try {
      const pc = createPeerConnection();
      const stream = new MediaStream();
      viewSessionRef.current = {
        peerId: `viewer_${randomId()}`,
        pc,
        stream,
        signalChannel: supabase.channel(getSignalChannelName(hostKey), {
          config: { broadcast: { self: true } },
        }),
      };

      pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          get().setViewStream(event.streams[0]);
          if (viewSessionRef.current) {
            viewSessionRef.current.stream = event.streams[0];
          }
        } else if (event.track) {
          stream.addTrack(event.track);
          get().setViewStream(stream);
        }
        get().setViewStatus("connected");
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          get().stopViewSession().catch(() => null);
        } else if (pc.connectionState === "connected") {
          console.log("Peer view connection established");
        }
      };

      const signalChannel = viewSessionRef.current.signalChannel;
      const peerId = viewSessionRef.current.peerId;

      signalChannel.on("broadcast", { event: VIEW_ANSWER_EVENT }, async ({ payload }) => {
        const message = payload as { peerId: string; answer: RTCSessionDescriptionInit; signature: string };
        if (message.peerId !== peerId) return;
        const verifyKey = await getVerifyKey(hostKey);
        const isValid = await verifyHostSignature(
          verifyKey,
          { peerId: message.peerId, answer: message.answer },
          message.signature
        );
        if (!isValid) {
          get().setViewError("Host signature is invalid.");
          await get().stopViewSession();
          return;
        }
        const description =
          typeof RTCSessionDescription !== "undefined"
            ? new RTCSessionDescription(message.answer)
            : message.answer;
        await pc.setRemoteDescription(description);
      });

      await subscribeToRealtimeChannel(signalChannel);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);
      if (!pc.localDescription) throw new Error("Missing local description");

      await signalChannel.send({
        type: "broadcast",
        event: VIEW_OFFER_EVENT,
        payload: {
          peerId,
          offer: pc.localDescription,
          timestamp: Date.now(),
        },
      });
    } catch (err) {
      console.error("Failed to start viewing stream", err);
      get().setViewStatus("error");
      get().setViewError(err instanceof Error ? err.message : "Failed to start viewing stream");
      await get().stopViewSession();
    }
  },

  // Host handlers
  broadcastLocalHostStatus: (channelId: string) => {
    const presence = presenceChannelRef.current;
    const state = get();
    if (!presence || !state.hostKeyPair) return;

    presence
      .send({
        type: "broadcast",
        event: HOST_STATUS_EVENT,
        payload: {
          hostId: channelId,
          hostKey: state.hostKeyPair.publicKeyString,
          broadcastPeers: state.broadcastPeers,
          activePeerId: state.activePeerId,
          timestamp: Date.now(),
        } satisfies HostStatusPayload,
      })
      .catch((err) => console.error("Failed to broadcast host heartbeat", err));
  },

  startHeartbeat: (channelId: string) => {
    const state = get();
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    state.broadcastLocalHostStatus(channelId);
    heartbeatRef.current = setInterval(() => {
      state.broadcastLocalHostStatus(channelId);
    }, HOST_BROADCAST_INTERVAL_MS);
  },

  stopHeartbeat: () => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  },

  handlePeerOffer: async (payload: PeerOfferMessage, channelId: string) => {
    const keyPair = hostKeyPairRef.current;
    const signalChannel = hostSignalChannelRef.current;
    if (!keyPair || !signalChannel) {
      console.warn("Host not ready to accept peer offer", { keyPair: !!keyPair, signalChannel: !!signalChannel });
      return;
    }

    const state = get();
    const peerId = payload.peerId;
    const alias = payload.alias || "Guest share";
    console.log("Host received peer offer", { peerId, alias });

    const closeHostSession = (peerId: string) => {
      const session = hostSessionsRef.get(peerId);
      if (!session) return;
      session.stream.getTracks().forEach((track) => track.stop());
      session.pc.ontrack = null;
      session.pc.onconnectionstatechange = null;
      session.pc.close();
      hostSessionsRef.delete(peerId);
      state.removeStreamingPeer(peerId);
    };

    if (hostSessionsRef.has(peerId)) {
      console.log("Closing existing session for peer", peerId);
      closeHostSession(peerId);
    }

    const existing = state.streamingPeers.find((p) => p.id === peerId);
    if (!existing) {
      state.addStreamingPeer({
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

      hostSessionsRef.set(peerId, {
        peerId,
        alias,
        nonce: payload.nonce,
        pc,
        stream,
        channelId,
      });

      const attachStreamToPeer = (peerId: string, stream: MediaStream, label: string, sessionId: string) => {
        const currentState = get();
        currentState.updateStreamingPeer(peerId, {
          label,
          screenTitle: "Live screen share",
          stream,
          sessionId,
        });
        if (!currentState.activePeerId) {
          currentState.setActivePeerId(peerId);
        }
      };

      pc.ontrack = (event) => {
        console.log("Host received track from peer", { peerId, trackId: event.track.id });
        if (event.streams && event.streams[0]) {
          attachStreamToPeer(peerId, event.streams[0], alias, peerId);
        } else if (event.track) {
          stream.addTrack(event.track);
          attachStreamToPeer(peerId, stream, alias, peerId);
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log("Host ICE candidate", { peerId, candidate: event.candidate.candidate });
        } else {
          console.log("Host ICE candidate gathering complete", { peerId });
        }
      };

      pc.oniceconnectionstatechange = () => {
        const iceState = pc.iceConnectionState;
        console.log("Host ICE connection state changed", { peerId, iceConnectionState: iceState });
        if (iceState === "failed") {
          console.log("Host ICE connection failed - closing session", { peerId });
          closeHostSession(peerId);
        }
      };

      pc.onconnectionstatechange = () => {
        const connectionState = pc.connectionState;
        console.log("Host peer connection state changed", { peerId, state: connectionState });
        if (connectionState === "failed" || connectionState === "closed") {
          console.log("Host peer connection closed", { peerId, state: connectionState });
          closeHostSession(peerId);
        } else if (connectionState === "connected") {
          console.log("Host peer connection established", { peerId });
        }
      };

      console.log("Host setting remote description", { peerId });
      await pc.setRemoteDescription(payload.offer);
      console.log("Host set remote description", { peerId });

      console.log("Host creating answer", { peerId });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      console.log("Host created answer", { peerId });

      console.log("Host waiting for ICE gathering", { peerId });
      await waitForIceGathering(pc);
      if (!pc.localDescription) {
        throw new Error("Missing local description after ICE gathering");
      }
      console.log("Host ICE gathering complete", { peerId });

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
      get().broadcastLocalHostStatus(channelId);
    } catch (err) {
      console.error("Failed to process peer offer", { peerId, error: err });
      closeHostSession(peerId);
    }
  },

  handleViewOffer: async (payload: { peerId: string; offer: RTCSessionDescriptionInit }) => {
    const keyPair = hostKeyPairRef.current;
    const signalChannel = hostSignalChannelRef.current;
    const state = get();
    const activePeer = state.activePeerId
      ? state.streamingPeers.find((p) => p.id === state.activePeerId)
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
  },

  startHostSignalChannel: async (hostKey: string) => {
    const state = get();
    if (hostSignalChannelRef.current) {
      await hostSignalChannelRef.current.unsubscribe().catch(() => null);
      hostSignalChannelRef.current = null;
    }
    const channelName = getSignalChannelName(hostKey);
    console.log("Host starting signal channel", { channelName });
    const signalChannel = supabase.channel(channelName, { config: { broadcast: { self: false } } });

    signalChannel.on("broadcast", { event: PEER_OFFER_EVENT }, ({ payload }) => {
      console.log("Host received PEER_OFFER_EVENT", payload);
      const currentState = get();
      const channelId = currentState.hostChannelId;
      if (channelId) {
        state.handlePeerOffer(payload as PeerOfferMessage, channelId);
      }
    });
    signalChannel.on("broadcast", { event: VIEW_OFFER_EVENT }, ({ payload }) => {
      console.log("Host received VIEW_OFFER_EVENT", payload);
      state.handleViewOffer(payload as { peerId: string; offer: RTCSessionDescriptionInit });
    });

    await subscribeToRealtimeChannel(signalChannel);
    console.log("Host signal channel subscribed", { channelName });
    hostSignalChannelRef.current = signalChannel;
  },

  initializeHost: async (channelId: string) => {
    try {
      if (typeof window === "undefined" || !window.crypto?.subtle) {
        throw new Error("Web Crypto API is not available in this environment.");
      }

      const keyPair = await generateHostKeyPair();
      hostKeyPairRef.current = keyPair;
      const state = get();
      state.setHostKeyPair(keyPair);
      await state.startHostSignalChannel(keyPair.publicKeyString);
      state.broadcastLocalHostStatus(channelId);
      state.startHeartbeat(channelId);
    } catch (err) {
      console.error("Failed to initialize host", err);
    }
  },

  teardownHostSessions: () => {
    const state = get();
    const closeHostSession = (peerId: string) => {
      const session = hostSessionsRef.get(peerId);
      if (!session) return;
      session.stream.getTracks().forEach((track) => track.stop());
      session.pc.ontrack = null;
      session.pc.onconnectionstatechange = null;
      session.pc.close();
      hostSessionsRef.delete(peerId);
      state.removeStreamingPeer(peerId);
    };
    Array.from(hostSessionsRef.keys()).forEach((peerId) => closeHostSession(peerId));
    Array.from(viewSessionsRef.values()).forEach((pc) => pc.close());
    viewSessionsRef.clear();
  },

  handleHighlightPeer: (peerId: string) => {
    get().setActivePeerId(peerId);
  },

  // WebRTC sessions are managed via refs in components/services
}));

