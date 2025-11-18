import { useEffect } from "react";
import { useChannels } from "../store/channelStoreHelpers";
import { initChannelListSubscriptions } from "../lib/channelSubscriptions";

type ChannelListScreenProps = {
  onStartChannel: () => void;
  onSelectChannel: (hostKey: string) => void;
};

export function ChannelListScreen({ onStartChannel, onSelectChannel }: ChannelListScreenProps) {
  const channels = useChannels();

  // Initialize subscriptions on mount, cleanup on unmount
  useEffect(() => {
    return initChannelListSubscriptions();
  }, []);

  return (
    <div className="app">
      <div className="page">
        <div className="card">
          <header className="header">
            <div className="header-content">
              <h1>Active Channels</h1>
              <p className="muted">{channels.length} channel{channels.length !== 1 ? "s" : ""} available</p>
            </div>
          </header>

          <section className="section">
            <div className="channel-list">
              {channels.length === 0 ? (
                <p className="muted">Waiting for hosts to appear…</p>
              ) : (
                channels.map((channel) => (
                  <button
                    key={channel.id}
                    className="channel-item"
                    onClick={() => onSelectChannel(channel.hostKey)}
                  >
                    <div>
                      <p className="label">Host public key</p>
                      <code>{channel.hostKey}</code>
                    </div>
                    <span>{channel.broadcastPeers} peer{channel.broadcastPeers !== 1 ? "s" : ""}</span>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="section">
            <button className="btn btn-primary" onClick={onStartChannel}>
              Start Channel
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}

