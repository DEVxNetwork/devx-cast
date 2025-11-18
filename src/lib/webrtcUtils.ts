import type { RealtimeChannel } from "@supabase/supabase-js";

export const textEncoder = new TextEncoder();

export const arrayBufferToBase64Url = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

export const base64UrlToArrayBuffer = (value: string) => {
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

export const getSignalChannelName = (hostKey: string) => `signal-${hostKey}`;

export const PEER_OFFER_EVENT = "peer-offer";
export const HOST_ANSWER_EVENT = "host-answer";
export const HOST_TERMINATE_EVENT = "host-terminate";
export const VIEW_OFFER_EVENT = "view-offer";
export const VIEW_ANSWER_EVENT = "view-answer";
export const HOST_DIRECTORY_CHANNEL = "host-directory";
export const HOST_STATUS_EVENT = "host-status";
export const HOST_STOP_EVENT = "host-stop";
export const HOST_BROADCAST_INTERVAL_MS = 2_000;

export const subscribeToRealtimeChannel = (channel: RealtimeChannel) =>
  new Promise<void>((resolve, reject) => {
    channel.subscribe((status: string) => {
      if (status === "SUBSCRIBED") {
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        reject(new Error(`Channel ${channel.topic} status: ${status}`));
      }
    });
  });

export const encodePayload = (payload: unknown) => textEncoder.encode(JSON.stringify(payload));

export const importHostPublicKey = (publicKeyString: string) =>
  crypto.subtle.importKey(
    "spki",
    base64UrlToArrayBuffer(publicKeyString),
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["verify"]
  );

export const verifyHostSignature = async (publicKey: CryptoKey, payload: object, signature: string) => {
  const signatureBuffer = base64UrlToArrayBuffer(signature);
  return crypto.subtle.verify(
    {
      name: "ECDSA",
      hash: "SHA-256",
    },
    publicKey,
    signatureBuffer,
    encodePayload(payload)
  );
};

export const signPayload = (privateKey: CryptoKey, payload: object) =>
  crypto.subtle
    .sign(
      {
        name: "ECDSA",
        hash: "SHA-256",
      },
      privateKey,
      encodePayload(payload)
    )
    .then(arrayBufferToBase64Url);

export const generateHostKeyPair = async (): Promise<{
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyString: string;
}> => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign", "verify"]
  );
  const publicBuffer = await crypto.subtle.exportKey("spki", keyPair.publicKey);
  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    publicKeyString: arrayBufferToBase64Url(publicBuffer),
  };
};

export const randomId = () => Math.random().toString(36).slice(2, 10);

export const waitForIceGathering = async (pc: RTCPeerConnection) => {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const checkState = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", checkState);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", checkState);
  });
};

export const createPeerConnection = () =>
  new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

