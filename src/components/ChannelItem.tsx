type ChannelItemProps = {
  hostKey: string;
  broadcastPeers: number;
  onClick: () => void;
};

export function ChannelItem({ hostKey, broadcastPeers, onClick }: ChannelItemProps) {
  return (
    <button className="channel-item" onClick={onClick}>
      <div>
        <p className="label">Host public key</p>
        <code>{hostKey}</code>
      </div>
      <span>{broadcastPeers} peer{broadcastPeers !== 1 ? "s" : ""}</span>
    </button>
  );
}

