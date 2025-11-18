import type { ReactNode } from "react";

type StreamingPeersSectionProps = {
  peerCount: number;
  children: ReactNode;
};

export function StreamingPeersSection({ peerCount, children }: StreamingPeersSectionProps) {
  return (
    <section className="section">
      <div className="section-header">
        <div className="section-title">
          <p className="label">Streaming peers</p>
          <p className="muted" style={{ fontSize: "0.875rem", margin: 0 }}>
            Only peers actively sharing are shown here.
          </p>
        </div>
        <span className="section-count">{peerCount}</span>
      </div>
      {children}
    </section>
  );
}

