import { ChannelItem } from "./ChannelItem";
import { EmptyState } from "./EmptyState";

type Channel = {
  id: string;
  hostKey: string;
  broadcastPeers: number;
};

type ChannelListProps = {
  channels: Channel[];
  onSelectChannel: (hostKey: string) => void;
};

export function ChannelList({ channels, onSelectChannel }: ChannelListProps) {
  return (
    <div className="channel-list">
      {channels.length === 0 ? (
        <EmptyState message="Waiting for hosts to appear…" />
      ) : (
        channels.map((channel) => (
          <ChannelItem
            key={channel.id}
            hostKey={channel.hostKey}
            broadcastPeers={channel.broadcastPeers}
            onClick={() => onSelectChannel(channel.hostKey)}
          />
        ))
      )}
    </div>
  );
}

