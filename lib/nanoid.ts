// Simple ID generator (no dependency needed)
export function nanoid(size = 21): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const randomValues = new Uint8Array(size);
  if (typeof crypto !== "undefined") {
    crypto.getRandomValues(randomValues);
  } else {
    for (let i = 0; i < size; i++) randomValues[i] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < size; i++) {
    result += chars[randomValues[i] % chars.length];
  }
  return result;
}
