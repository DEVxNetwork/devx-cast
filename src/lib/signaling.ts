import { supabase } from "./supabase";
import type { OfferRecord, AnswerRecord, OfferStatus, CreateOfferPayload } from "./types";
import type { RealtimeChannel } from "@supabase/supabase-js";

const OFFER_TABLE = "offers";
const ANSWER_TABLE = "answers";

export function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function mapOfferRow(row: any): OfferRecord {
  return {
    id: row.id,
    caster_name: row.caster_name,
    room_code: row.room_code,
    status: row.status,
    offer: row.offer,
    created_at: row.created_at,
  };
}

export async function createOffer({ offer, casterName, roomCode }: CreateOfferPayload) {
  const { data, error } = await supabase
    .from(OFFER_TABLE)
    .insert({
      offer,
      caster_name: casterName,
      room_code: roomCode,
      status: "pending",
    })
    .select("*")
    .single();

  if (error) throw error;
  return mapOfferRow(data);
}

export function subscribeToOffers(callback: (record: OfferRecord) => void) {
  const channel = supabase
    .channel("offers-stream")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: OFFER_TABLE },
      (payload) => {
        callback(mapOfferRow(payload.new));
      }
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: OFFER_TABLE },
      (payload) => {
        callback(mapOfferRow(payload.new));
      }
    )
    .subscribe();

  return async () => {
    await channel.unsubscribe();
  };
}

export async function fetchPendingOffers() {
  const { data, error } = await supabase
    .from(OFFER_TABLE)
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(mapOfferRow);
}

export async function saveAnswer(offerId: string, answer: RTCSessionDescriptionInit) {
  const { error } = await supabase.from(ANSWER_TABLE).insert({
    offer_id: offerId,
    answer,
  });

  if (error) throw error;
}

export async function updateOfferStatus(offerId: string, status: OfferStatus) {
  const { error } = await supabase
    .from(OFFER_TABLE)
    .update({ status })
    .eq("id", offerId);

  if (error) throw error;
}

export function subscribeToAnswer(offerId: string, callback: (record: AnswerRecord) => void) {
  const channel = supabase
    .channel(`answer-${offerId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: ANSWER_TABLE, filter: `offer_id=eq.${offerId}` },
      (payload) => {
        callback({
          id: payload.new.id,
          offer_id: payload.new.offer_id,
          answer: payload.new.answer,
          created_at: payload.new.created_at,
        });
      }
    )
    .subscribe();

  return async () => {
    await channel.unsubscribe();
  };
}

export async function fetchExistingAnswer(offerId: string) {
  const { data, error } = await supabase
    .from(ANSWER_TABLE)
    .select("*")
    .eq("offer_id", offerId)
    .single();

  if (error && error.code !== "PGRST116") throw error;
  if (!data) return null;

  return {
    id: data.id,
    offer_id: data.offer_id,
    answer: data.answer,
    created_at: data.created_at,
  } satisfies AnswerRecord;
}


