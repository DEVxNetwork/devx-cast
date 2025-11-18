type ChannelListHeaderProps = {
  channelCount: number;
};

export function ChannelListHeader({ channelCount }: ChannelListHeaderProps) {
  return (
    <header className="header">
      <div className="header-content">
        <h1>Active Channels</h1>
        <p className="muted">{channelCount} channel{channelCount !== 1 ? "s" : ""} available</p>
      </div>
    </header>
  );
}

