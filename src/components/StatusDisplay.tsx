type StatusDisplayProps = {
  status: string;
};

export function StatusDisplay({ status }: StatusDisplayProps) {
  return <p className="muted">Status: {status}</p>;
}

