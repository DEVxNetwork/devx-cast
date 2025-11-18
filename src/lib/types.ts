export type OfferStatus = "pending" | "accepted" | "denied" | "completed";

export interface OfferRecord {
  id: string;
  caster_name: string | null;
  room_code: string | null;
  status: OfferStatus;
  offer: RTCSessionDescriptionInit;
  created_at: string;
}

export interface AnswerRecord {
  id: string;
  offer_id: string;
  answer: RTCSessionDescriptionInit;
  created_at: string;
}

export interface CreateOfferPayload {
  offer: RTCSessionDescriptionInit;
  casterName: string;
  roomCode: string;
}

export interface SupabaseSubscription<T> {
  unsubscribe: () => Promise<void>;
  channelId: string;
  onUpdate?: (payload: T) => void;
}


