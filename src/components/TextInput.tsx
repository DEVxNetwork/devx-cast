type TextInputProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
};

export function TextInput({ label, value, onChange, placeholder }: TextInputProps) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <input
        className="field-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

