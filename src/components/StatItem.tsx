type StatItemProps = {
  label: string;
  value: string | number;
  valueStyle?: React.CSSProperties;
};

export function StatItem({ label, value, valueStyle }: StatItemProps) {
  return (
    <div className="stat">
      <p className="label stat-label">{label}</p>
      <span className="stat-value" style={valueStyle}>
        {value}
      </span>
    </div>
  );
}

