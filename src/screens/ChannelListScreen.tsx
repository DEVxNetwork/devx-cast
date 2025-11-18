import { useEffect } from "react";
import { useChannels } from "../store/channelStoreHelpers";
import { initChannelListSubscriptions } from "../lib/channelSubscriptions";
import { ChannelListHeader } from "../components/ChannelListHeader";
import { ChannelList } from "../components/ChannelList";
import { StartChannelButton } from "../components/StartChannelButton";

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
          <ChannelListHeader channelCount={channels.length} />

          <section className="section">
            <ChannelList channels={channels} onSelectChannel={onSelectChannel} />
          </section>

          <StartChannelButton onClick={onStartChannel} />
        </div>
      </div>
    </div>
  );
}

