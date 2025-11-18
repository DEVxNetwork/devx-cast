type ScreenHeaderProps = {
  label: string;
  value: string;
  backButtonLabel: string;
  onBack: () => void;
};

export function ScreenHeader({ label, value, backButtonLabel, onBack }: ScreenHeaderProps) {
  return (
    <header className="header">
      <div className="header-content">
        <p className="label">{label}</p>
        <code>{value}</code>
      </div>
      <button className="btn btn-secondary" onClick={onBack}>
        {backButtonLabel}
      </button>
    </header>
  );
}

