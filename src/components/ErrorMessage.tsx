type ErrorMessageProps = {
  message: string | null;
};

export function ErrorMessage({ message }: ErrorMessageProps) {
  if (!message || message === "null") return null;
  return <p className="error">{message}</p>;
}

