# Zustand State Management Migration Guide

## Overview

This project now uses **Zustand** for centralized state management. Zustand is a lightweight, simple state management library that:
- Requires no providers or context setup
- Works great with TypeScript
- Has minimal boilerplate
- Supports async actions naturally
- Prevents unnecessary re-renders with selective subscriptions

## Architecture

### Zustand Store (`src/store/channelStore.ts`)
- **Reactive UI state**: Channels, peers, status, errors
- **Serializable data only**: No RTCPeerConnection, MediaStream, or RealtimeChannel

### WebRTC Refs (`src/store/webrtcRefs.ts`)
- **Non-reactive WebRTC objects**: RTCPeerConnection, MediaStream, RealtimeChannel
- **Centralized refs**: Shared across components but not reactive
- **Helper functions**: Cleanup utilities

### Helper Hooks (`src/store/channelStoreHelpers.ts`)
- **Selective subscriptions**: Prevents unnecessary re-renders
- **Computed selectors**: Derived state like `useActivePeer`

## Migration Steps

### 1. Replace useState with Zustand selectors

**Before:**
```tsx
const [streamingPeers, setStreamingPeers] = useState<StreamingPeer[]>([]);
const [activePeerId, setActivePeerId] = useState<string | null>(null);
```

**After:**
```tsx
import { useHostState, useHostActions } from "../store/channelStoreHelpers";

const { streamingPeers, activePeerId } = useHostState();
const { setActivePeerId, addStreamingPeer } = useHostActions();
```

### 2. Replace useRef with centralized refs

**Before:**
```tsx
const hostSessionsRef = useRef<Map<string, HostSession>>(new Map());
const hostKeyPairRef = useRef<HostKeyPair | null>(null);
```

**After:**
```tsx
import { hostSessionsRef, hostKeyPairRef } from "../store/webrtcRefs";

// Use directly - no need for .current
hostSessionsRef.set(peerId, session);
const keyPair = hostKeyPairRef.current;
```

### 3. Update callbacks to use store actions

**Before:**
```tsx
const handlePeerOffer = useCallback(async (payload) => {
  setStreamingPeers((prev) => [...prev, newPeer]);
}, []);
```

**After:**
```tsx
import { useHostActions } from "../store/channelStoreHelpers";

const { addStreamingPeer } = useHostActions();

const handlePeerOffer = useCallback(async (payload) => {
  addStreamingPeer(newPeer);
}, [addStreamingPeer]);
```

## Benefits

1. **No dependency issues**: Zustand actions are stable references
2. **Centralized state**: Easy to debug and inspect
3. **Selective re-renders**: Components only re-render when their selected state changes
4. **Type-safe**: Full TypeScript support
5. **Simple API**: No providers, no context, just hooks

## Example: Migrated Component

See `src/screens/ChannelListScreen.tsx` for a complete example of a migrated component.

## Next Steps

1. Migrate `ChannelListScreen.tsx` (simplest, good starting point)
2. Migrate `ChannelPeerScreen.tsx` (peer state)
3. Migrate `ChannelHostScreen.tsx` (most complex, host state)
4. Remove old useState/useRef patterns
5. Test thoroughly

