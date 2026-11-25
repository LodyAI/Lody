export type ClassValue =
  | string
  | number
  | null
  | false
  | undefined
  | ClassValue[]
  | { [key: string]: unknown };

const appendClassValue = (value: ClassValue, out: string[]) => {
  if (!value) return;
  if (typeof value === 'string' || typeof value === 'number') {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) appendClassValue(item, out);
    return;
  }
  for (const key of Object.keys(value)) {
    if (value[key]) out.push(key);
  }
};

export function cn(...inputs: ClassValue[]) {
  const out: string[] = [];
  for (const input of inputs) appendClassValue(input, out);
  return out.join(' ');
}
