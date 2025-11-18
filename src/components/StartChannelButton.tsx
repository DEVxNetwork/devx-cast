type StartChannelButtonProps = {
  onClick: () => void;
};

export function StartChannelButton({ onClick }: StartChannelButtonProps) {
  return (
    <section className="section">
      <button className="btn btn-primary" onClick={onClick}>
        Start Channel
      </button>
    </section>
  );
}

