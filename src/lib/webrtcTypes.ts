export type PeerOfferMessage = {
  peerId: string;
  alias: string;
  offer: RTCSessionDescriptionInit;
  nonce: string;
  timestamp: number;
};

export type HostAnswerMessage = {
  peerId: string;
  nonce: string;
  answer: RTCSessionDescriptionInit;
  signature: string;
  timestamp: number;
};

export type HostStatusPayload = {
  hostId: string;
  hostKey: string;
  broadcastPeers: number;
  activePeerId: string | null;
  timestamp: number;
};

export type HostKeyPair = {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyString: string;
};

