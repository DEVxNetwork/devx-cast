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

/**
 * Creates a peer connection with optimized configuration for low latency and high quality
 */
export const createPeerConnection = () => {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
    iceCandidatePoolSize: 10, // Pre-gather candidates for faster connection
    bundlePolicy: "max-bundle", // Reduce connection overhead
    rtcpMuxPolicy: "require", // Multiplex RTP and RTCP for lower latency
  });

  // Configure codec preferences for low latency
  // VP9/VP8 are generally better for screen sharing than H.264
  pc.addEventListener("negotiationneeded", () => {
    // This will be handled when we create offers/answers
  });

  return pc;
};

/**
 * Optimizes SDP for low latency and high quality
 * Uses minimal, safe SDP manipulation to avoid breaking the format
 * Returns original SDP if manipulation fails to ensure compatibility
 */
export const optimizeSdpForLowLatency = (sdp: string): string => {
  if (!sdp || typeof sdp !== "string" || sdp.length === 0) {
    return sdp;
  }

  try {
    let optimizedSdp = sdp;
    
    // Only add bandwidth if not present and m=video line is properly formatted
    const videoLineMatch = optimizedSdp.match(/m=video \d+ [A-Z\/]+/);
    if (videoLineMatch && !optimizedSdp.includes("b=AS:") && !optimizedSdp.includes("b=TIAS:")) {
      // Verify the m=video line has at least 4 fields (media, port, proto, fmt)
      const videoLine = videoLineMatch[0]!;
      const fields = videoLine.split(" ");
      if (fields.length >= 4) {
        optimizedSdp = optimizedSdp.replace(
          videoLine,
          `${videoLine}\r\nb=AS:5000`
        );
      }
    }

    // Add start bitrate for faster startup (only if not present)
    if (!optimizedSdp.includes("x-google-start-bitrate")) {
      const fmtpMatch = optimizedSdp.match(/a=fmtp:\d+[^\r\n]+/);
      if (fmtpMatch) {
        optimizedSdp = optimizedSdp.replace(
          fmtpMatch[0]!,
          `${fmtpMatch[0]}\r\na=x-google-start-bitrate:2500000`
        );
      }
    }

    // Validate that we didn't break the SDP format
    // Check that m=video lines still have proper format
    const videoLines = optimizedSdp.match(/m=video[^\r\n]+/g);
    if (videoLines) {
      for (const line of videoLines) {
        const fields = line.split(" ");
        if (fields.length < 4) {
          // SDP is malformed, return original
          console.warn("SDP optimization would create invalid format, using original");
          return sdp;
        }
      }
    }

    return optimizedSdp;
  } catch (error) {
    console.warn("SDP optimization failed, using original:", error);
    return sdp;
  }
};

/**
 * Configures video track parameters for optimal quality and latency
 */
export const configureVideoTrack = async (
  sender: RTCRtpSender,
  options: {
    maxBitrate?: number; // in bps
    maxFramerate?: number;
    scaleResolutionDownBy?: number;
  } = {}
): Promise<void> => {
  const {
    maxBitrate = 5_000_000, // 5 Mbps default
    maxFramerate = 60,
    scaleResolutionDownBy = 1,
  } = options;

  try {
    const params = sender.getParameters();
    
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }

    // Configure encoding parameters
    params.encodings[0] = {
      ...params.encodings[0],
      maxBitrate,
      maxFramerate,
      scaleResolutionDownBy,
    };

    await sender.setParameters(params);
  } catch (error) {
    console.warn("Failed to configure video track parameters:", error);
    // Non-fatal - continue without optimization
  }
};

/**
 * Gets optimized media constraints for screen sharing
 * Higher quality settings for better visual fidelity
 */
export const getScreenShareConstraints = (): DisplayMediaStreamOptions => ({
  video: {
    displaySurface: "monitor", // Prefer full monitor capture
    width: { ideal: 1920, max: 3840 },
    height: { ideal: 1080, max: 2160 },
    frameRate: { ideal: 60, max: 60 },
    cursor: "always", // Include cursor for better UX
  } as any, // TypeScript doesn't have DisplayMediaTrackConstraints type
  audio: false,
});

/**
 * Applies optimizations to a peer connection after tracks are added
 */
export const optimizePeerConnection = async (
  pc: RTCPeerConnection
): Promise<void> => {
  // Configure all video senders
  const senders = pc.getSenders();
  for (const sender of senders) {
    if (sender.track?.kind === "video") {
      await configureVideoTrack(sender, {
        maxBitrate: 5_000_000, // 5 Mbps
        maxFramerate: 60,
      });
    }
  }
};

