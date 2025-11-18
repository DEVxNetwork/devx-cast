import type { ReactNode } from "react";

type OptionCardProps = {
  title: string;
  description: string;
  children: ReactNode;
};

export function OptionCard({ title, description, children }: OptionCardProps) {
  return (
    <div className="option-card">
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}

