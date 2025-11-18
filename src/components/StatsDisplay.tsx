import { StatItem } from "./StatItem";

type StatsDisplayProps = {
  broadcastPeers: number;
  activePeerLabel: string | null;
};

export function StatsDisplay({ broadcastPeers, activePeerLabel }: StatsDisplayProps) {
  return (
    <div className="stats">
      <StatItem label="Broadcast peer count" value={broadcastPeers} />
      <StatItem
        label="Active streaming peer"
        value={activePeerLabel ?? "None"}
        valueStyle={{ fontSize: "1rem", fontWeight: "normal" }}
      />
    </div>
  );
}

