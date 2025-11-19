import { create } from "zustand";
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
  VIEW_ANSWER_EVENT, HOST_STATUS_EVENT,
  HOST_BROADCAST_INTERVAL_MS,
  subscribeToRealtimeChannel,
  randomId,
  waitForIceGathering,
  createPeerConnection
} from "../lib/webrtcUtils";
import {
  generateHostKeyPair,
  importHostPublicKey,
  signPayload,
  verifyHostSignature,
  type HostKeyPair as ECDSAHostKeyPair,
} from "../lib/ecdsa";
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
  hostKeyPair: ECDSAHostKeyPair | null;
  streamingPeers: StreamingPeer[];
  activePeerId: string | null;
  broadcastPeers: number;
  
  // Host actions
  setHostKeyPair: (keyPair: ECDSAHostKeyPair | null) => void;
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
  localShareStream: MediaStream | null;

  // Peer actions
  setShareStatus: (status: ShareStatus) => void;
  setShareError: (error: string | null) => void;
  setShareAlias: (alias: string) => void;
  setViewStatus: (status: ViewStatus) => void;
  setViewError: (error: string | null) => void;
  setViewStream: (stream: MediaStream | null) => void;
  setLocalShareStream: (stream: MediaStream | null) => void;
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
  hostKeyPair: null,
  streamingPeers: [],
  activePeerId: null,
  broadcastPeers: 0,

  // Host actions
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
  localShareStream: null,

  // Peer actions
  setShareStatus: (status) => set({ shareStatus: status }),
  setShareError: (error) => set({ shareError: error }),
  setShareAlias: (alias) => set({ shareAlias: alias }),
  setViewStatus: (status) => set({ viewStatus: status }),
  setViewError: (error) => set({ viewError: error }),
  setViewStream: (stream) => set({ viewStream: stream }),
  setLocalShareStream: (stream) => set({ localShareStream: stream }),
  clearPeerState: () =>
    set({
      shareStatus: "idle",
      shareError: null,
      shareAlias: "Guest share",
      viewStatus: "idle",
      viewError: null,
      viewStream: null,
      localShareStream: null,
    }),

  // Peer handlers
  stopShareSession: async () => {
    const session = shareSessionRef.current;
    if (!session) {
      console.log("[DEBUG] stopShareSession called but no session exists");
      return;
    }
    
    console.log("[DEBUG] stopShareSession called", { peerId: session.peerId });
    
    // Clear the ref first to prevent race conditions
    shareSessionRef.current = null;
    
    // Clean up tracks
    session.stream.getTracks().forEach((track) => {
      track.onended = null; // Clear event handlers
      track.stop();
    });
    
    // Clean up peer connection
    session.pc.onconnectionstatechange = null;
    session.pc.close();
    
    // Unsubscribe from signal channel
    await session.signalChannel.unsubscribe().catch(() => null);
    
    // Update state
    console.log("[DEBUG] Setting share status to idle");
    get().setShareStatus("idle");
    get().setShareError(null);
    get().setLocalShareStream(null);
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
    console.log("[DEBUG] handleShareScreen called", { hostKey, hasExistingSession: !!shareSessionRef.current });
    const state = get();
    if (shareSessionRef.current) {
      console.log("[DEBUG] Stopping existing session");
      await state.stopShareSession();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      console.error("[DEBUG] Screen sharing not supported");
      state.setShareError("Screen sharing is not supported in this browser.");
      return;
    }
    state.setShareError(null);
    state.setShareStatus("prompting");
    console.log("[DEBUG] Status set to prompting");

    const getVerifyKey = async (hostKey: string) => {
      const cached = verifyKeyCacheRef.get(hostKey);
      if (cached) return cached;
      const imported = await importHostPublicKey(hostKey);
      verifyKeyCacheRef.set(hostKey, imported);
      return imported;
    };

    try {
      console.log("[DEBUG] Requesting screen share...");
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      get().setLocalShareStream(stream);
      console.log("[DEBUG] Screen share stream obtained", { 
        trackCount: stream.getVideoTracks().length,
        trackStates: stream.getVideoTracks().map(t => ({ id: t.id, enabled: t.enabled, readyState: t.readyState }))
      });
      
      if (!stream.getVideoTracks().length) {
        throw new Error("No video track captured");
      }

      console.log("[DEBUG] Creating peer connection");
      const pc = createPeerConnection();
      stream.getVideoTracks().forEach((track) => {
        console.log("[DEBUG] Adding track to peer connection", { trackId: track.id });
        pc.addTrack(track, stream);
      });

      const channelName = getSignalChannelName(hostKey);
      console.log("[DEBUG] Creating signal channel", { channelName });
      const signalChannel = supabase.channel(channelName, {
        config: { broadcast: { self: true } },
      });
      const peerId = `peer_${randomId()}`;
      const nonce = `nonce_${randomId()}${randomId()}`;
      console.log("[DEBUG] Generated peer ID and nonce", { peerId, nonce });

      signalChannel.on("broadcast", { event: HOST_ANSWER_EVENT }, async ({ payload }) => {
        console.log("[DEBUG] Received HOST_ANSWER_EVENT", { payload, peerId, nonce });
        const message = payload as HostAnswerMessage;
        if (message.peerId !== peerId || message.nonce !== nonce) {
          console.log("[DEBUG] Message doesn't match - ignoring", { 
            messagePeerId: message.peerId, 
            messageNonce: message.nonce,
            expectedPeerId: peerId,
            expectedNonce: nonce
          });
          return;
        }
        console.log("[DEBUG] Message matches - verifying signature");
        const verifyKey = await getVerifyKey(hostKey);
        const verifyPayload = { peerId: message.peerId, nonce: message.nonce, answer: message.answer };
        console.log("[DEBUG] Verifying payload", { verifyPayload: JSON.stringify(verifyPayload) });
        const isValid = await verifyHostSignature(
          verifyKey,
          verifyPayload,
          message.signature
        );
        if (!isValid) {
          console.error("[DEBUG] Host signature is invalid");
          get().setShareError("Host signature is invalid.");
          await get().stopShareSession();
          return;
        }
        console.log("[DEBUG] Signature valid - setting remote description");
        const description =
          typeof RTCSessionDescription !== "undefined"
            ? new RTCSessionDescription(message.answer)
            : message.answer;
        await pc.setRemoteDescription(description);
        console.log("[DEBUG] Remote description set - connection should be established");
        get().setShareStatus("connected");
      });

      signalChannel.on("broadcast", { event: HOST_TERMINATE_EVENT }, () => {
        console.log("[DEBUG] Received HOST_TERMINATE_EVENT");
        get().stopShareSession().catch(() => null);
      });

      console.log("[DEBUG] Subscribing to signal channel");
      await subscribeToRealtimeChannel(signalChannel);
      console.log("[DEBUG] Signal channel subscribed");

      shareSessionRef.current = {
        peerId,
        nonce,
        hostKey,
        pc,
        stream,
        signalChannel,
      };
      console.log("[DEBUG] Session stored in ref", { peerId });

      // Handle track ended (user stops sharing in browser)
      stream.getVideoTracks().forEach((track) => {
        track.onended = () => {
          console.log("[DEBUG] Screen share track ended", { peerId });
          // Only stop if this is still the current session
          if (shareSessionRef.current?.peerId === peerId) {
            get().stopShareSession().catch(() => null);
          }
        };
      });

      pc.onconnectionstatechange = () => {
        const currentSession = shareSessionRef.current;
        // Only act on this session if it's still the current one
        if (!currentSession || currentSession.peerId !== peerId) {
          console.log("[DEBUG] Connection state change for stale session - ignoring", { 
            currentPeerId: currentSession?.peerId, 
            thisPeerId: peerId 
          });
          return;
        }
        
        const connectionState = pc.connectionState;
        console.log("[DEBUG] Peer share connection state changed", { peerId, connectionState, iceConnectionState: pc.iceConnectionState, iceGatheringState: pc.iceGatheringState });
        
        if (connectionState === "failed" || connectionState === "closed") {
          console.error("[DEBUG] Peer share connection failed/closed", { peerId, connectionState });
          get().stopShareSession().catch(() => null);
        } else if (connectionState === "connected") {
          console.log("[DEBUG] Peer share connection established", { peerId });
        }
      };

      console.log("[DEBUG] Creating offer");
      get().setShareStatus("publishing");
      const offer = await pc.createOffer();
      console.log("[DEBUG] Offer created", { type: offer.type, sdp: offer.sdp?.substring(0, 100) });
      await pc.setLocalDescription(offer);
      console.log("[DEBUG] Local description set, waiting for ICE gathering");
      await waitForIceGathering(pc);
      if (!pc.localDescription) throw new Error("Missing local description");
      console.log("[DEBUG] ICE gathering complete", { localDescription: pc.localDescription });

      get().setShareStatus("awaiting");
      console.log("[DEBUG] Sending offer to host", { peerId, hostKey, channelName, alias: state.shareAlias });
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
      console.log("[DEBUG] Peer offer sent successfully", { peerId });
    } catch (err) {
      console.error("[DEBUG] Failed to start screen share", err);
      get().setShareStatus("error");
      get().setShareError(err instanceof Error ? err.message : "Failed to start screen share");
      await get().stopShareSession();
    }
  },

  handleViewStream: async (hostKey: string) => {
    // Note: Viewing streams is independent of screen sharing.
    // A peer can view streams without sharing their own screen.
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
        console.log("[DEBUG] Received VIEW_ANSWER_EVENT", { messagePeerId: message.peerId, expectedPeerId: peerId });
        if (message.peerId !== peerId) {
          console.log("[DEBUG] View answer peerId mismatch - ignoring", { messagePeerId: message.peerId, expectedPeerId: peerId });
          return;
        }
        console.log("[DEBUG] View answer matches - verifying signature");
        const verifyKey = await getVerifyKey(hostKey);
        const verifyPayload = { peerId: message.peerId, answer: message.answer };
        console.log("[DEBUG] Verifying view answer payload", { verifyPayload: JSON.stringify(verifyPayload) });
        const isValid = await verifyHostSignature(
          verifyKey,
          verifyPayload,
          message.signature
        );
        if (!isValid) {
          console.error("[DEBUG] Host signature is invalid for view answer");
          get().setViewError("Host signature is invalid.");
          await get().stopViewSession();
          return;
        }
        console.log("[DEBUG] View answer signature valid - setting remote description");
        const description =
          typeof RTCSessionDescription !== "undefined"
            ? new RTCSessionDescription(message.answer)
            : message.answer;
        await pc.setRemoteDescription(description);
        console.log("[DEBUG] View remote description set - connection should be established");
      });

      await subscribeToRealtimeChannel(signalChannel);

      // Create offer for receiving-only connection (no local tracks needed)
      // The viewer only receives tracks from the host, doesn't send any
      // Add transceivers configured for receive-only to ensure the offer includes media sections
      console.log("[DEBUG] Creating view offer (receive-only, no local tracks)");
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);
      if (!pc.localDescription) throw new Error("Missing local description");
      
      console.log("[DEBUG] View offer created and ICE gathering complete", { 
        peerId, 
        offerType: pc.localDescription.type,
        sdpLines: pc.localDescription.sdp?.split('\n').length || 0
      });

      await signalChannel.send({
        type: "broadcast",
        event: VIEW_OFFER_EVENT,
        payload: {
          peerId,
          offer: pc.localDescription,
          timestamp: Date.now(),
        },
      });
      console.log("[DEBUG] View offer sent to host", { peerId });
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
    console.log("[DEBUG HOST] handlePeerOffer called", { payload, channelId });
    const keyPair = hostKeyPairRef.current;
    const signalChannel = hostSignalChannelRef.current;
    if (!keyPair || !signalChannel) {
      console.warn("[DEBUG HOST] Host not ready to accept peer offer", { keyPair: !!keyPair, signalChannel: !!signalChannel });
      return;
    }

    const state = get();
    const peerId = payload.peerId;
    const alias = payload.alias || "Guest share";
    console.log("[DEBUG HOST] Host received peer offer", { peerId, alias, nonce: payload.nonce });

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

      // Normalize RTCSessionDescription to plain object for consistent signing
      const answerObj = {
        type: pc.localDescription.type,
        sdp: pc.localDescription.sdp,
      };
      
      const signedPayload = {
        peerId,
        nonce: payload.nonce,
        answer: answerObj,
      };
      console.log("Host signing answer", { peerId, signedPayload: JSON.stringify(signedPayload) });
      const signature = await signPayload(keyPair.privateKey, signedPayload);

      console.log("[DEBUG HOST] Host sending answer to peer", { peerId, signalChannel: !!signalChannel, channelName: getSignalChannelName(state.hostKeyPair!.publicKeyString) });
        await signalChannel.send({
          type: "broadcast",
          event: HOST_ANSWER_EVENT,
          payload: {
            peerId: signedPayload.peerId,
            nonce: signedPayload.nonce,
            answer: signedPayload.answer, // Use normalized answer object
            signature,
            timestamp: Date.now(),
          } satisfies HostAnswerMessage,
        });

      console.log("[DEBUG HOST] Host sent answer to peer successfully", { peerId, answerType: signedPayload.answer.type });
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
    
    if (!keyPair || !signalChannel) {
      console.log("[DEBUG HOST] Cannot handle view offer - missing keyPair or signalChannel", {
        hasKeyPair: !!keyPair,
        hasSignalChannel: !!signalChannel
      });
      return;
    }

    // Find active peer or first streaming peer
    const activePeer = state.activePeerId
      ? state.streamingPeers.find((p) => p.id === state.activePeerId)
      : state.streamingPeers.length > 0
      ? state.streamingPeers[0]
      : null;

    if (!activePeer) {
      console.log("[DEBUG HOST] Cannot handle view offer - no streaming peers available");
      return;
    }

    const viewerId = payload.peerId;
    console.log("[DEBUG HOST] Handling view offer", { viewerId, activePeerId: activePeer.id });
    
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
        console.log("[DEBUG HOST] Added tracks to view session", { 
          viewerId, 
          trackCount: activePeer.stream.getTracks().length 
        });
      } else {
        console.warn("[DEBUG HOST] Active peer has no stream", { activePeerId: activePeer.id });
      }

      pc.onconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
          console.log("[DEBUG HOST] View session connection closed", { viewerId, state: pc.connectionState });
          viewSessionsRef.delete(viewerId);
        }
      };

      await pc.setRemoteDescription(payload.offer);
      console.log("[DEBUG HOST] Set remote description for view offer", { viewerId });
      
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGathering(pc);
      if (!pc.localDescription) throw new Error("Missing local description");

      // Normalize RTCSessionDescription to plain object for consistent signing
      const answerObj = {
        type: pc.localDescription.type,
        sdp: pc.localDescription.sdp,
      };

      const signedPayload = {
        peerId: viewerId,
        answer: answerObj,
      };
      console.log("[DEBUG HOST] Signing view answer", { viewerId, signedPayload: JSON.stringify(signedPayload) });
      const signature = await signPayload(keyPair.privateKey, signedPayload);

      await signalChannel.send({
        type: "broadcast",
        event: VIEW_ANSWER_EVENT,
        payload: {
          peerId: signedPayload.peerId,
          answer: signedPayload.answer,
          signature,
          timestamp: Date.now(),
        },
      });
      console.log("[DEBUG HOST] Sent view answer to viewer", { viewerId });
    } catch (err) {
      console.error("[DEBUG HOST] Failed to process view offer", { viewerId, error: err });
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
    console.log("[DEBUG HOST] Host starting signal channel", { channelName, hostKey });
    const signalChannel = supabase.channel(channelName, { config: { broadcast: { self: false } } });

    signalChannel.on("broadcast", { event: PEER_OFFER_EVENT }, ({ payload }) => {
      console.log("[DEBUG HOST] Host received PEER_OFFER_EVENT", payload);
      const currentState = get();
      const channelId = currentState.hostChannelId;
      console.log("[DEBUG HOST] Processing peer offer", { channelId, hasChannelId: !!channelId });
      if (channelId) {
        state.handlePeerOffer(payload as PeerOfferMessage, channelId);
      } else {
        console.error("[DEBUG HOST] No channelId available to process peer offer");
      }
    });
    signalChannel.on("broadcast", { event: VIEW_OFFER_EVENT }, ({ payload }) => {
      console.log("[DEBUG HOST] Host received VIEW_OFFER_EVENT", payload);
      state.handleViewOffer(payload as { peerId: string; offer: RTCSessionDescriptionInit });
    });

    await subscribeToRealtimeChannel(signalChannel);
    console.log("[DEBUG HOST] Host signal channel subscribed successfully", { channelName });
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

