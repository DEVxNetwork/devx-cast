import { useEffect, useMemo, useRef, useState } from "react";
import { fetchPendingOffers, saveAnswer, subscribeToOffers, updateOfferStatus } from "../lib/signaling";
import type { OfferRecord } from "../lib/types";

interface ActiveSession {
  pc: RTCPeerConnection;
  stream: MediaStream | null;
  record: OfferRecord;
}

export function Presenter() {
  const [offers, setOffers] = useState<OfferRecord[]>([]);
  const [sessions, setSessions] = useState<Map<string, ActiveSession>>(new Map());
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());

  const roomFilter = useMemo(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return params.get("room");
  }, []);

  const pending = offers.filter((offer) => offer.status === "pending");
  const active = Array.from(sessions.values());

  useEffect(() => {
    let isMounted = true;
    fetchPendingOffers()
      .then((records) => {
        if (isMounted) {
          setOffers(records);
        }
      })
      .catch((err) => console.error("Failed to fetch offers", err));

    const unsubscribe = subscribeToOffers((record) => {
      setOffers((prev) => {
        const map = new Map(prev.map((item) => [item.id, item]));
        map.set(record.id, record);
        return Array.from(map.values()).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      });
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  const makePeer = (offerId: string) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pc.ontrack = (event) => {
      setSessions((prev) => {
        const next = new Map(prev);
        const session = next.get(offerId);
        if (!session) return prev;
        const stream = event.streams?.[0] ?? session.stream ?? new MediaStream();
        if (event.track && !stream.getTracks().includes(event.track)) {
          stream.addTrack(event.track);
        }
        next.set(offerId, { ...session, stream });
        return next;
      });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        setSessions((prev) => {
          const next = new Map(prev);
          next.delete(offerId);
          return next;
        });
      }
    };

    return pc;
  };

  const waitForIceGathering = async (pc: RTCPeerConnection) => {
    if (pc.iceGatheringState === "complete") return;
    await new Promise<void>((resolve) => {
      const check = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", check);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", check);
    });
  };

  const handleAcceptOffer = async (offer: OfferRecord) => {
    try {
      const pc = makePeer(offer.id);
      setSessions((prev) => {
        const next = new Map(prev);
        next.set(offer.id, { pc, stream: null, record: offer });
        return next;
      });

      await pc.setRemoteDescription(offer.offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGathering(pc);

      if (!pc.localDescription) throw new Error("Missing local description");
      await saveAnswer(offer.id, pc.localDescription);
      await updateOfferStatus(offer.id, "accepted");
    } catch (err) {
      console.error("Failed to accept offer", err);
      alert(err instanceof Error ? err.message : "Failed to accept offer");
    }
  };

  const handleDenyOffer = async (offer: OfferRecord) => {
    await updateOfferStatus(offer.id, "denied");
  };

  const handleFullscreen = async (offerId: string) => {
    const session = sessions.get(offerId);
    if (!session?.stream) return;
    const video = document.createElement("video");
    video.srcObject = session.stream;
    video.autoplay = true;
    video.controls = true;
    video.style.width = "100%";
    video.style.height = "100%";
    video.style.objectFit = "contain";

    const container = document.createElement("div");
    container.className = "fullscreen-shell";
    container.appendChild(video);

    const close = document.createElement("button");
    close.textContent = "Close";
    close.className = "ghost-button";
    close.onclick = () => container.remove();
    container.appendChild(close);

    document.body.appendChild(container);
    await video.play().catch(() => null);
  };

  useEffect(() => {
    return () => {
      sessions.forEach((session) => session.pc.close());
    };
  }, [sessions]);

  useEffect(() => {
    sessions.forEach((session, offerId) => {
      const video = videoRefs.current.get(offerId);
      if (video && session.stream && video.srcObject !== session.stream) {
        video.srcObject = session.stream;
      }
    });
  }, [sessions]);

  const filteredPending = roomFilter
    ? pending.filter((offer) => offer.room_code?.toLowerCase() === roomFilter.toLowerCase())
    : pending;

  return (
    <div className="presenter-stack">
      <section className="panel">
        <div className="metrics">
          <div>
            <p>Pending casters</p>
            <strong>{filteredPending.length}</strong>
          </div>
          <div>
            <p>Active feeds</p>
            <strong>{active.length}</strong>
          </div>
          <div>
            <p>Room filter</p>
            <strong>{roomFilter ?? "All rooms"}</strong>
          </div>
        </div>
      </section>

      <section className="panel">
        <header className="panel-header">
          <div>
            <p className="panel-eyebrow">Pending</p>
            <h3>Incoming requests</h3>
          </div>
        </header>
        <div className="cards-grid">
          {filteredPending.length === 0 && <p className="muted">No pending casters. Share a room code to get started.</p>}
          {filteredPending.map((offer) => (
            <article key={offer.id} className="offer-card">
              <header>
                <div>
                  <p>{offer.caster_name ?? "Unknown caster"}</p>
                  <span>Room · {offer.room_code ?? "n/a"}</span>
                </div>
                <span className="badge">{offer.status}</span>
              </header>
              <footer>
                <button className="action-button" onClick={() => handleAcceptOffer(offer)}>
                  Accept
                </button>
                <button className="ghost-button" onClick={() => handleDenyOffer(offer)}>
                  Deny
                </button>
              </footer>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <header className="panel-header">
          <div>
            <p className="panel-eyebrow">Live feeds</p>
            <h3>Connected casters</h3>
          </div>
        </header>
        <div className="streams-grid">
          {active.length === 0 && <p className="muted">No active feeds yet.</p>}
          {active.map((session) => (
            <article key={session.record.id} className="stream-card">
              <header>
                <div>
                  <p>{session.record.caster_name ?? "Unnamed caster"}</p>
                  <span>{session.record.room_code ?? "No room"}</span>
                </div>
                <button className="ghost-button" onClick={() => handleFullscreen(session.record.id)}>
                  Fullscreen
                </button>
              </header>
              <video
                ref={(el) => {
                  if (!el) {
                    videoRefs.current.delete(session.record.id);
                  } else {
                    videoRefs.current.set(session.record.id, el);
                    if (session.stream && el.srcObject !== session.stream) {
                      el.srcObject = session.stream;
                    }
                  }
                }}
                autoPlay
                playsInline
                muted
                controls
              />
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
